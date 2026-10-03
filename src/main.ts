// The UI: the stamp form and its batch of photos, the recent strip, the gallery and the viewer.
import { prefs, readJson } from './prefs';
import { layout, overlayJpeg, renderPlan, SLOT_KEYS, stampedJpeg, type Plan } from './stamp';
import { DriveError, DriveFolder, findDriveFolders, loadSignInScript, signedIn, signIn, type FolderMatch } from './store/drive-folder';
import { LocalFolder } from './store/local-folder';
import { newBatchId, PHOTO_RE, photoName, pieceBase, today } from './store/naming';
import { categoryFolder, listPieces, loadPiece, type FileEntry, type Folder, type Piece } from './store/pieces';
import { clampRating, emptyInfo, formatInfo, isEditable, TEXT_FIELDS, type PieceInfo, type TextField } from './store/sidecar';

// the tests' pixel probes measure saved photos against the app's own slot layout
declare global { interface Window { layout: typeof layout } }
window.layout = layout;

/* ---------- DOM helpers ---------- */
function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing`);
  return el;
}
const $ = (id: string): HTMLElement => byId(id, HTMLElement);
const input = (id: string): HTMLInputElement => byId(id, HTMLInputElement);
const button = (id: string): HTMLButtonElement => byId(id, HTMLButtonElement);
const select = (id: string): HTMLSelectElement => byId(id, HTMLSelectElement);
const dialog = (id: string): HTMLDialogElement => byId(id, HTMLDialogElement);
function field(f: TextField): HTMLInputElement | HTMLTextAreaElement {
  const el = $(f);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  throw new Error(`#${f} is not a form field`);
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';
const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;
const mb = (b: Blob): string => (b.size / 1048576).toFixed(1) + ' MB';

// IndexedDB key-value store, for the folder handles (they can't go in localStorage)
function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('furniture-stamp', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const idbGet = <T>(key: string): Promise<T | undefined> => idb<T>('readonly', st => st.get(key));
const idbPut = (key: string, value: unknown): Promise<unknown> => idb('readwrite', st => { st.put(value, key); });

type Status = '' | 'ok' | 'err';
function say(text: string, cls: Status = ''): void {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + cls;
}

/* ---------- state ---------- */
// a photo in the current batch: new ones get the full stamp, existing ones (edit mode) an overlay
type Photo = { file: File; url: string; status: string; cls: Status; existing: boolean; name: string };
type EditSession = { folder: Folder; base: string; saved: PieceInfo; infoName: string; maxNum: number };

const LOCAL = 'showDirectoryPicker' in window;   // desktop Chrome/Edge: local folder; phones: Google Drive
let photos: Photo[] = [];
let selected = 0, busy = false;
let batchId = newBatchId();
let edit: EditSession | null = null;
let saveFolder: Folder | null = null;

function readForm(): PieceInfo {
  const info = emptyInfo();
  for (const f of TEXT_FIELDS) info[f] = field(f).value.trim();
  info.rating = clampRating(input('rating').value);
  info.seen = input('seen').checked;
  return info;
}

/* ---------- naming ---------- */
const baseName = (i: PieceInfo): string => pieceBase(i.category, batchId);
// new photos are numbered after the piece's existing ones in edit mode
function nameFor(idx: number): string {
  const fresh = photos.filter(p => !p.existing).length;
  const k = photos.slice(0, idx).filter(p => !p.existing).length;
  return edit ? photoName(edit.base, edit.maxNum + k, edit.maxNum + fresh)
    : photoName(baseName(readForm()), k, fresh);
}

/* ---------- edit rules ---------- */
// Filled fields of a saved piece are locked; empty ones get overlaid when filled.
// Rating and seen IRL can always change and are always redrawn.
const lockedIn = (saved: PieceInfo, f: TextField): boolean => !!saved[f];
const newKeys = (saved: PieceInfo, i: PieceInfo) => SLOT_KEYS.filter(k => !saved[k] && i[k]);
function editChanges(saved: PieceInfo, i: PieceInfo) {
  return { keys: newKeys(saved, i), rating: i.rating !== saved.rating, seen: i.seen !== saved.seen };
}
function mergedInfo(saved: PieceInfo, i: PieceInfo): PieceInfo {
  const m = { ...saved };
  for (const f of TEXT_FIELDS) if (!m[f] && i[f]) m[f] = i[f];
  m.rating = i.rating;
  m.seen = i.seen;
  return m;
}
// new photos get the full stamp; saved ones only what changed
function planFor(p: Photo, i: PieceInfo): Plan {
  const keys = p.existing && edit ? newKeys(edit.saved, i) : SLOT_KEYS;
  return { full: !p.existing, slots: Object.fromEntries(keys.map(k => [k, i[k]])), rating: i.rating, seen: i.seen };
}

/* ---------- categories ---------- */
const DEFAULT_CATS = ['Dining', 'Bedroom', 'Living', 'Tables'];
const isStringList = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === 'string');
let cats = ((): string[] => { const c = readJson('categories:v2'); return isStringList(c) ? c : DEFAULT_CATS; })();
function fillCats(): void {
  $('catList').innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">`).join('');
}

/* ---------- autofill history ---------- */
// past saves plus the sidecars in the save folder, newest first
type HistoryRecord = Record<TextField, string> & { date: string };
const HISTORY_FIELDS = [...TEXT_FIELDS, 'date'] as const;

// stored records from before the rename used "dims" and "notes"
function readHistory(): HistoryRecord[] {
  const stored = readJson('records');
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((o: unknown): HistoryRecord[] => {
    if (!o || typeof o !== 'object') return [];
    const str = (k: string): string => { const v: unknown = Reflect.get(o, k); return typeof v === 'string' ? v : ''; };
    const r: HistoryRecord = { category: str('category'), item: str('item'), store: str('store'), price: str('price'),
      size: str('size') || str('dims'), description: str('description') || str('notes'), date: str('date') };
    return r.item ? [r] : [];
  });
}
let history = readHistory();
const historyKey = (r: HistoryRecord): string => (r.item + '|' + r.store).toLowerCase();

// With `blanksOverwrite`, empty fields clear what was remembered (a form save says "no price");
// otherwise only filled fields count (a sidecar just has no line for them).
function remember(infos: PieceInfo[], blanksOverwrite: boolean): void {
  const map = new Map(history.map(r => [historyKey(r), r]));
  for (const info of infos) {
    if (!info.item) continue;
    const r = Object.fromEntries(HISTORY_FIELDS.map(k => [k, info[k]]).filter(([, v]) => blanksOverwrite || v)) as Partial<HistoryRecord>;
    const k = historyKey({ ...emptyInfo(), ...r });
    map.set(k, { ...emptyInfo(), ...map.get(k), ...r });
  }
  history = [...map.values()].map(r => Object.fromEntries(HISTORY_FIELDS.map(k => [k, r[k]])) as HistoryRecord)
    .sort((a, b) => b.date.localeCompare(a.date));
  prefs.set('records', JSON.stringify(history.slice(0, 500)));
  fillLists();
}
function fillLists(): void {
  const uniq = (k: TextField): string[] => [...new Set(history.map(r => r[k]).filter(Boolean))];
  const opts = (a: string[]): string => a.map(v => `<option value="${escapeHtml(v)}">`).join('');
  $('itemList').innerHTML = opts(uniq('item'));
  $('storeList').innerHTML = opts(uniq('store'));
  $('sizeList').innerHTML = opts(uniq('size'));
}
// picking a known item fills its other empty fields
function autofillFromItem(): void {
  const item = input('item').value.trim().toLowerCase();
  if (!item) return;
  const store = input('store').value.trim().toLowerCase();
  const r = history.find(r => r.item.toLowerCase() === item && (!store || r.store.toLowerCase() === store))
    ?? history.find(r => r.item.toLowerCase() === item);
  if (!r) return;
  for (const k of ['category', 'store', 'price', 'size', 'description'] as const) {
    const el = field(k);
    if (!el.readOnly && !el.value.trim() && r[k]) el.value = r[k];
  }
  render(); schedulePreview();
}

/* ---------- stamp view ---------- */
function render(): void {
  const i = readForm(), n = photos.length, fresh = photos.filter(p => !p.existing).length;
  if (edit) {
    const c = editChanges(edit.saved, i), nk = c.keys.length;
    const parts = [nk ? plural(nk, 'new field') : '', c.rating ? 'new rating' : '', c.seen ? 'seen IRL change' : ''].filter(Boolean);
    $('fnPreview').innerHTML = `Editing <b>${escapeHtml(edit.base)}</b>: ${parts.length ? parts.join(', ') + ' to overlay' : 'change the rating or seen IRL, or fill an empty field'}${fresh ? `, ${plural(fresh, 'new photo')}` : ''}.`;
  } else {
    const last = fresh > 1 ? ` … <b>_${String(fresh).padStart(Math.max(2, String(fresh).length), '0')}</b>` : '';
    $('fnPreview').innerHTML = `File names: <b>${escapeHtml(photoName(baseName(i), 0, Math.max(fresh, 1)))}</b>` + last;
  }

  const list = $('thumbs');
  list.innerHTML = '';
  photos.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = idx === selected ? 'sel' : '';
    li.tabIndex = 0;
    const name = p.existing ? p.name : nameFor(idx);
    li.innerHTML = `<img alt="" src="${p.url}"><div class="meta"><span class="tag">${p.existing ? 'saved' : 'new'}</span>${escapeHtml(name)}<span class="st ${p.cls}">${escapeHtml(p.status)}</span></div>` +
      (p.existing ? '' : `<button class="rm" type="button" aria-label="Remove photo">×</button>`);
    li.addEventListener('click', e => {
      if (e.target instanceof Element && e.target.closest('.rm')) { removePhoto(idx); return; }
      selected = idx; render(); schedulePreview();
    });
    li.addEventListener('keydown', e => { if (e.key === 'Enter') { selected = idx; render(); schedulePreview(); } });
    list.appendChild(li);
  });

  const save = button('save'), download = button('download'), clear = button('clear'), editBtn = button('editBtn');
  save.textContent = edit ? 'Apply to piece' : 'Save to folder';
  save.disabled = busy || !i.category || !saveFolder || (!edit && !n);
  download.disabled = busy || !n || !i.category || !!edit;
  clear.hidden = !!edit;
  clear.disabled = busy || !n;
  editBtn.textContent = edit ? 'Cancel edit' : LOCAL ? 'Edit a saved piece' : 'Edit from gallery';
  editBtn.disabled = busy;
  $('editBanner').hidden = !edit;
  if (edit) $('editBanner').textContent = 'Edit mode: filled fields are locked. Empty ones get overlaid onto the saved photos. Rating and seen IRL can always change.';
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePreview(): void { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 250); }
async function drawPreview(): Promise<void> {
  const box = $('preview'), p = photos[selected];
  if (!p) { box.innerHTML = ''; return; }
  let c = box.querySelector('canvas');
  if (!c) { c = document.createElement('canvas'); box.innerHTML = ''; box.appendChild(c); }
  try { await renderPlan(p.file, planFor(p, readForm()), c); }
  catch { p.status = "Can't read this format"; p.cls = 'err'; render(); }
}

const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`;
function addFiles(files: Iterable<File | null>): void {
  const imgs = [...files].filter((f): f is File => !!f && f.type.startsWith('image/'));
  if (!imgs.length) return;
  for (const f of imgs) photos.push({ file: f, url: URL.createObjectURL(f), status: '', cls: '', existing: false, name: '' });
  say(''); render(); schedulePreview(); syncRecentMarks();
}
function removePhoto(idx: number): void {
  URL.revokeObjectURL(photos[idx].url);
  photos.splice(idx, 1);
  selected = Math.min(selected, Math.max(0, photos.length - 1));
  render(); schedulePreview(); syncRecentMarks();
}
function clearPhotos(): void {
  for (const p of photos) URL.revokeObjectURL(p.url);
  photos = []; selected = 0; batchId = newBatchId();
  render(); void drawPreview(); syncRecentMarks();
}

/* ---------- save folder ---------- */
function showFolder(): void {
  $('folderName').textContent = saveFolder ? saveFolder.name : 'No folder chosen';
  render();
}
async function refreshFromFolder(): Promise<void> {
  try {
    if (saveFolder && await saveFolder.allowed()) remember((await listPieces(saveFolder)).map(p => p.info), false);
  } catch { /* history is a convenience; ignore an unreadable folder */ }
}

// One loop for every way of writing photos: marks each photo's status as it goes; returns how many failed.
async function stampEach(
  steps: { photo: Photo; busyText: string; doneText: (blob: Blob) => string; failText: string; run: (c: HTMLCanvasElement) => Promise<Blob> }[],
): Promise<number> {
  const canvas = document.createElement('canvas');
  let failed = 0;
  for (const s of steps) {
    try {
      s.photo.status = s.busyText; s.photo.cls = ''; render();
      const blob = await s.run(canvas);
      s.photo.status = s.doneText(blob); s.photo.cls = 'ok';
    } catch (e) { s.photo.status = e instanceof DriveError ? e.message : s.failText; s.photo.cls = 'err'; failed++; }
    render();
  }
  return failed;
}

async function saveNew(root: Folder): Promise<void> {
  const i = readForm(), n = photos.length;
  const base = baseName(i);
  const folder = await categoryFolder(root, i.category);
  const failed = await stampEach(photos.map((p, k) => ({
    photo: p, busyText: 'Stamping…', doneText: blob => `Saved (${mb(blob)})`, failText: "Can't read this format",
    run: async c => { const blob = await stampedJpeg(p.file, planFor(p, i), c); await folder.write(photoName(base, k, n), blob); return blob; },
  })));
  const saved = { ...i, date: today() };
  await folder.write(`${base}.txt`, formatInfo(saved));
  remember([saved], true);
  if (!failed) { resetForm(); clearPhotos(); say(`Saved ${plural(n, 'photo')} to ${root.name}/${folder.name}.`, 'ok'); }
  else say(`Saved ${n - failed} of ${n}. Check the photos marked in red.`, 'err');
}

async function applyEdit(session: EditSession): Promise<void> {
  const i = readForm(), ch = editChanges(session.saved, i);
  const fresh = photos.filter(p => !p.existing);
  const overlay = ch.keys.length > 0 || ch.rating || ch.seen;
  if (!overlay && !fresh.length) { say('Nothing new to add. Change the rating or seen IRL, fill an empty field, or drop new photos.', 'err'); return; }
  const failed = await stampEach(photos.flatMap((p, idx) => p.existing && !overlay ? [] : [{
    photo: p, busyText: p.existing ? 'Overlaying…' : 'Stamping…', doneText: () => 'Updated', failText: 'Failed',
    run: async (c: HTMLCanvasElement) => {
      const blob = await (p.existing ? overlayJpeg : stampedJpeg)(p.file, planFor(p, i), c);
      await session.folder.write(p.existing ? p.name : nameFor(idx), blob);
      return blob;
    },
  }]));
  const merged = mergedInfo(session.saved, i);
  await session.folder.write(session.infoName, formatInfo(merged));
  remember([merged], false);
  if (!failed) { exitEdit(); say(`Updated ${session.base}.`, 'ok'); }
  else say(`${plural(failed, 'photo')} failed. Check the ones marked in red.`, 'err');
}

// desktop: pick any photo of a saved piece; phones edit from the gallery instead
async function enterEdit(): Promise<void> {
  if (!LOCAL) { showView('gallery'); return; }
  const root = saveFolder;
  if (!(root instanceof LocalFolder)) { say('Choose your save folder first.', 'err'); return; }
  if (!await root.allowed(true)) { say('Folder access was denied.', 'err'); return; }
  if (photos.length && !confirm('Discard the photos in the current batch?')) return;
  let picked: FileSystemFileHandle;
  try {
    [picked] = await showOpenFilePicker({ startIn: root.handle, types: [{ description: 'Saved photos', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }] });
  } catch (e) { if (!isAbort(e)) say(errorText(e), 'err'); return; }
  const at = await root.locate(picked);
  if (!at) { say(`Pick a photo from inside ${root.name}.`, 'err'); return; }
  const m = at.name.match(PHOTO_RE);
  if (!m) { say("That file name doesn't follow the naming pattern.", 'err'); return; }
  await loadEdit(at.folder, m[1]);
}

async function loadEdit(folder: Folder, base: string): Promise<void> {
  const { info, infoName, photos: files } = await loadPiece(folder, base);
  if (!info || !infoName || !isEditable(info)) { say('This piece was saved before the fixed layout, so its empty slots are unknown. Only pieces saved from now on can be edited.', 'err'); return; }
  clearPhotos();
  edit = { folder, base, saved: info, infoName, maxNum: Math.max(0, ...files.map(f => f.num)) };
  for (const f of TEXT_FIELDS) { const el = field(f); el.value = info[f]; el.readOnly = lockedIn(info, f); }
  input('rating').value = String(info.rating);
  input('seen').checked = info.seen;
  showRating();
  photos = files.map(f => ({ file: f.file, url: URL.createObjectURL(f.file), name: f.name, existing: true, status: '', cls: '' }));
  selected = 0;
  say(`Loaded ${plural(files.length, 'photo')}.`);
  render(); schedulePreview();
}
function resetForm(): void {
  for (const f of TEXT_FIELDS) { const el = field(f); el.readOnly = false; el.value = ''; }
  input('rating').value = '0';
  input('seen').checked = false;
  showRating();
}
function exitEdit(): void {
  edit = null;
  resetForm();
  clearPhotos();
}

button('save').onclick = async () => {
  if (!readForm().category) { say('Add a category first.', 'err'); $('category').focus(); return; }
  busy = true; render();
  try {
    if (!saveFolder || !await saveFolder.allowed(true)) throw new Error('Folder access was denied. Choose the folder again.');
    if (edit) await applyEdit(edit); else await saveNew(saveFolder);
  } catch (e) { say(errorText(e), 'err'); }
  finally { busy = false; render(); }
};
button('editBtn').onclick = () => { if (edit) { exitEdit(); say(''); } else void enterEdit(); };

/* ---------- download ---------- */
button('download').onclick = async () => {
  busy = true; render();
  const i = readForm(), n = photos.length, base = baseName(i), c = document.createElement('canvas');
  let failed = 0;
  for (let k = 0; k < n; k++) {
    try {
      const blob = await stampedJpeg(photos[k].file, planFor(photos[k], i), c);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = photoName(base, k, n);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      await new Promise(r => setTimeout(r, 300));   // browsers drop downloads fired too quickly
    } catch { photos[k].status = "Can't read this format"; photos[k].cls = 'err'; failed++; }
  }
  remember([{ ...i, date: today() }], true);
  busy = false;
  if (!failed) { clearPhotos(); say(`Downloaded ${plural(n, 'photo')}.`, 'ok'); }
  else { render(); say(`Downloaded ${n - failed} of ${n}. Check the photos marked in red.`, 'err'); }
};

/* ---------- recent photos strip (desktop) ---------- */
let sourceFolder: FileSystemDirectoryHandle | null = null, recentUrls: string[] = [];
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
// marks the recent photos that are already in the batch
function syncRecentMarks(): void {
  const added = new Set(photos.map(p => fileKey(p.file)));
  document.querySelectorAll<HTMLButtonElement>('#recentList button')
    .forEach(b => b.classList.toggle('added', added.has(b.dataset.key ?? '')));
}
async function loadRecent(): Promise<void> {
  const list = $('recentList'), hint = $('recentHint'), src = sourceFolder;
  if (!src) { list.innerHTML = ''; return; }
  $('recentTitle').textContent = `Recent in ${src.name}`;
  $('recentPick').textContent = 'Change folder';
  if (await src.queryPermission({ mode: 'read' }) !== 'granted') {
    hint.innerHTML = '<button class="linkbtn" id="recentAllow" type="button">Allow access</button> to show the latest photos.';
    hint.hidden = false; list.innerHTML = '';
    button('recentAllow').onclick = async () => { if (await src.requestPermission({ mode: 'read' }) === 'granted') void loadRecent(); };
    return;
  }
  const files: File[] = [];
  for await (const [name, h] of src.entries())
    if (h.kind === 'file' && IMG_EXT.test(name)) { try { files.push(await h.getFile()); } catch { /* skip unreadable */ } }
  files.sort((a, b) => b.lastModified - a.lastModified);
  const top = files.slice(0, 5);
  recentUrls.forEach(u => URL.revokeObjectURL(u)); recentUrls = [];
  $('recentRefresh').hidden = false;
  hint.hidden = top.length > 0; hint.textContent = 'No photos in this folder yet.';
  list.innerHTML = '';
  for (const f of top) {
    const url = URL.createObjectURL(f); recentUrls.push(url);
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.title = f.name; b.dataset.key = fileKey(f);
    b.innerHTML = `<img alt="" src="${url}"><small>${escapeHtml(ago(f.lastModified))}</small>`;
    // click toggles: adds the photo, or removes it again if it's new in the batch
    b.onclick = () => {
      const idx = photos.findIndex(p => fileKey(p.file) === b.dataset.key);
      if (idx >= 0) { if (!photos[idx].existing) removePhoto(idx); } else addFiles([f]);
    };
    li.appendChild(b); list.appendChild(li);
  }
  syncRecentMarks();
}

/* ---------- gallery ---------- */
type GalleryPhoto = FileEntry & { url?: string; thumbUrl?: string };   // object URLs, made on first view
type GalleryPiece = Omit<Piece, 'photos'> & { photos: GalleryPhoto[]; price: number | null; editable: boolean };
type Tile = { piece: GalleryPiece; photo: GalleryPhoto; k: number };
let pieces: GalleryPiece[] = [], thumbObserver: IntersectionObserver | null = null, galleryTiles: Tile[] = [], viewerIndex = 0;

// "24,500 EGP" → 24500, "24.5k" → 24500, Arabic digits too; null when there's no number
function parsePrice(s: string): number | null {
  if (!s) return null;
  const t = s.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,\s]/g, '');
  const m = t.match(/\d+(\.\d+)?/);
  if (!m || m.index === undefined) return null;
  let v = +m[0];
  if (/^\d+(\.\d+)?k/i.test(t.slice(m.index))) v *= 1000;
  return v;
}
function fillSelect(id: string, label: string, values: string[]): void {
  const el = select(id), cur = el.value;
  el.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  el.value = values.includes(cur) ? cur : '';
}
async function loadGallery(): Promise<void> {
  $('gGrid').innerHTML = '';
  const root = saveFolder;
  if (!root) { $('gCount').textContent = 'Choose your save folder on the Stamp tab first.'; return; }
  if (!await root.allowed()) {
    $('gCount').innerHTML = '<button class="linkbtn" id="gAllow" type="button">Allow folder access</button> to show your pieces.';
    button('gAllow').onclick = async () => { if (await root.allowed(true)) void loadGallery(); };
    return;
  }
  $('gCount').textContent = 'Scanning…';
  for (const p of pieces) for (const f of p.photos) {
    if (f.url) URL.revokeObjectURL(f.url);
    if (f.thumbUrl && f.thumbUrl !== f.url) URL.revokeObjectURL(f.thumbUrl);
  }
  pieces = (await listPieces(root)).map(p => ({ ...p, photos: p.photos.map(f => ({ ...f })), price: parsePrice(p.info.price), editable: isEditable(p.info) }));
  const uniq = (k: TextField): string[] => [...new Set(pieces.map(p => p.info[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fillSelect('gCat', 'All categories', [...new Set([...cats, ...uniq('category')])]);
  fillSelect('gStore', 'All stores', uniq('store'));
  renderGallery();
}

function filteredPieces(): GalleryPiece[] {
  const q = input('gSearch').value.trim().toLowerCase(), cat = select('gCat').value, store = select('gStore').value;
  const num = (id: string): number | null => input(id).value === '' ? null : +input(id).value;
  const min = num('gMin'), max = num('gMax');
  const rating = select('gRating').value, seen = select('gSeen').value;
  return pieces.filter(p => {
    const m = p.info;
    if (cat && m.category !== cat) return false;
    if (store && m.store !== store) return false;
    if ((min !== null || max !== null) && p.price === null) return false;
    if (min !== null && p.price !== null && p.price < min) return false;
    if (max !== null && p.price !== null && p.price > max) return false;
    if (rating === '0' && m.rating !== 0) return false;              // "Unrated"
    if (rating && rating !== '0' && m.rating < +rating) return false; // "N and up"
    if (seen && m.seen !== (seen === 'yes')) return false;
    if (q && !`${m.item} ${m.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
type Compare = (a: GalleryPiece, b: GalleryPiece) => number;
// unpriced pieces go last either way
const byPrice = (dir: number): Compare => (a, b) => Number(a.price === null) - Number(b.price === null) || dir * ((a.price ?? 0) - (b.price ?? 0));
const SORTS: Record<string, Compare> = {
  new: (a, b) => (b.info.date || b.base).localeCompare(a.info.date || a.base),
  priceAsc: byPrice(1),
  priceDesc: byPrice(-1),
  rating: (a, b) => b.info.rating - a.info.rating,
};

const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
function tileHtml({ piece: p, k }: Tile, index: number): string {
  const m = p.info;
  const stars = '<b>' + '★'.repeat(m.rating) + '</b>' + '★'.repeat(5 - m.rating);
  const sub = [m.category, m.store].filter(Boolean).map(escapeHtml).join(' | ');
  return `<div class="card">
      <button class="open" type="button" aria-label="Expand photo"><img class="ph" alt="" data-i="${index}"></button>
      <div class="body">
        <div class="t">${escapeHtml(m.item || m.category || p.base)}</div>
        <div class="m">${sub}${m.price ? `${sub ? ' | ' : ''}<span class="price">${escapeHtml(m.price)}</span>` : ''}${m.size ? ` | ${escapeHtml(m.size)}` : ''}</div>
        <div class="r"><span aria-label="${m.rating} of 5 stars">${stars}</span>${m.seen ? '<span class="seen">✓ Seen IRL</span>' : ''}</div>
      </div>
      <div class="foot">
        <span>Photo ${k + 1} of ${p.photos.length}${m.date ? ` | ${escapeHtml(m.date)}` : ''}${p.editable ? '' : ' | older layout'}</span>
        ${p.editable ? `<button class="iconbtn" type="button" aria-label="Edit this piece" title="Edit piece">${EDIT_ICON}</button>` : ''}
      </div></div>`;
}

function renderGallery(): void {
  const list = filteredPieces().sort(SORTS[select('gSort').value]);
  const tiles = list.flatMap(piece => piece.photos.map((photo, k) => ({ piece, photo, k })));
  galleryTiles = tiles;
  const all = pieces.reduce((n, p) => n + p.photos.length, 0);
  $('gCount').textContent = `${tiles.length} of ${all} photo${all === 1 ? '' : 's'} (${list.length} of ${pieces.length} piece${pieces.length === 1 ? '' : 's'})`;

  // thumbnails load as they scroll into view
  thumbObserver?.disconnect();
  const observer = thumbObserver = new IntersectionObserver(async entries => {
    for (const e of entries) {
      if (!e.isIntersecting || !(e.target instanceof HTMLImageElement)) continue;
      observer.unobserve(e.target);
      const f = tiles[Number(e.target.dataset.i)].photo;
      try {
        f.thumbUrl ??= f.thumb ? URL.createObjectURL(await f.thumb()) : (f.url ??= URL.createObjectURL(await f.read()));
        e.target.src = f.thumbUrl;
      } catch { /* leave the tile blank */ }
    }
  }, { rootMargin: '200px' });

  const grid = $('gGrid');
  grid.innerHTML = '';
  tiles.forEach((tile, index) => {
    const li = document.createElement('li');
    li.innerHTML = tileHtml(tile, index);
    li.querySelector<HTMLButtonElement>('.open')?.addEventListener('click', () => openViewer(index));
    li.querySelector('.iconbtn')?.addEventListener('click', () => void openPiece(tile.piece, tile.photo.name));
    const img = li.querySelector('img');
    if (img) observer.observe(img);
    grid.appendChild(li);
  });
  if (!tiles.length && pieces.length) $('gCount').textContent += '. Nothing matches these filters.';
}

async function openPiece(p: GalleryPiece, photoName: string): Promise<void> {
  if (!p.editable) { say('', ''); alert('This piece was saved with an older layout, so it can’t be edited.'); return; }
  if (photos.length && !edit && !confirm('Discard the photos in the current batch?')) return;
  showView('stamp');
  await loadEdit(p.folder, p.base);
  const idx = photos.findIndex(x => x.name === photoName);
  if (idx >= 0) { selected = idx; render(); schedulePreview(); }
}

/* ---------- photo viewer ---------- */
async function showViewer(): Promise<void> {
  const t = galleryTiles[viewerIndex];
  if (!t) return;
  const m = t.piece.info, img = byId('lbImg', HTMLImageElement);
  try { t.photo.url ??= URL.createObjectURL(await t.photo.read()); img.src = t.photo.url; } catch { /* keep the previous image */ }
  img.alt = m.item || m.category || '';
  $('lbCaption').textContent = `${[m.item, m.store, m.price].filter(Boolean).join(' | ') || m.category || t.piece.base}  (${viewerIndex + 1} / ${galleryTiles.length})`;
  button('lbPrev').disabled = viewerIndex === 0;
  button('lbNext').disabled = viewerIndex === galleryTiles.length - 1;
}
function openViewer(i: number): void { viewerIndex = i; dialog('lightbox').showModal(); void showViewer(); }
function stepViewer(d: number): void {
  const n = viewerIndex + d;
  if (n >= 0 && n < galleryTiles.length) { viewerIndex = n; void showViewer(); }
}
button('lbClose').onclick = () => dialog('lightbox').close();
button('lbPrev').onclick = () => stepViewer(-1);
button('lbNext').onclick = () => stepViewer(1);
dialog('lightbox').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepViewer(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepViewer(1); }
});
dialog('lightbox').addEventListener('click', e => {
  if (e.target instanceof Element && e.target.classList.contains('lb-stage')) dialog('lightbox').close();
});
let touchX: number | null = null;
$('lbImg').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
$('lbImg').addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
  touchX = null;
});

/* ---------- tabs ---------- */
function showView(v: 'stamp' | 'gallery'): void {
  const g = v === 'gallery';
  $('stampView').hidden = g; $('galleryView').hidden = !g;
  $('tabStamp').setAttribute('aria-pressed', String(!g)); $('tabGallery').setAttribute('aria-pressed', String(g));
  if (g) void loadGallery();
}
button('tabStamp').onclick = () => showView('stamp');
button('tabGallery').onclick = () => showView('gallery');
button('gRefresh').onclick = () => void loadGallery();
for (const id of ['gSearch', 'gMin', 'gMax']) $(id).addEventListener('input', renderGallery);
for (const id of ['gCat', 'gStore', 'gRating', 'gSeen', 'gSort']) $(id).addEventListener('change', renderGallery);
button('gReset').onclick = () => {
  for (const id of ['gSearch', 'gMin', 'gMax']) input(id).value = '';
  for (const id of ['gCat', 'gStore', 'gRating', 'gSeen']) select(id).value = '';
  select('gSort').value = 'new';
  renderGallery();
};

/* ---------- rating control ---------- */
function showRating(): void {
  const v = clampRating(input('rating').value);
  $('stars').querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    const n = Number(b.dataset.v);
    b.classList.toggle('on', n <= v);
    b.setAttribute('aria-checked', String(n === v));
  });
}
$('stars').addEventListener('click', e => {
  const b = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button') : null;
  if (!b) return;
  const n = Number(b.dataset.v), rating = input('rating');
  rating.value = String(clampRating(rating.value) === n ? 0 : n);   // click current rating again to clear
  showRating(); render(); schedulePreview();
});

/* ---------- form bindings ---------- */
for (const f of TEXT_FIELDS) field(f).addEventListener('input', () => { render(); schedulePreview(); });
input('seen').addEventListener('change', () => { render(); schedulePreview(); });
input('item').addEventListener('change', autofillFromItem);
// Tab completes to the first matching suggestion
for (const id of ['category', 'item', 'store', 'size']) {
  const el = input(id);
  el.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || el.readOnly) return;
    const v = el.value.trim().toLowerCase();
    if (!v) return;
    const opts = [...(el.list?.options ?? [])].map(o => o.value);
    if (opts.some(o => o.toLowerCase() === v)) return;
    const hit = opts.find(o => o.toLowerCase().startsWith(v)) ?? opts.find(o => o.toLowerCase().includes(v));
    if (!hit) return;
    el.value = hit;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
}
button('editCats').onclick = () => { byId('catText', HTMLTextAreaElement).value = cats.join('\n'); dialog('catDialog').showModal(); };
dialog('catDialog').addEventListener('close', () => {
  if (dialog('catDialog').returnValue !== 'save') return;
  cats = [...new Set(byId('catText', HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean))];
  prefs.set('categories:v2', JSON.stringify(cats));
  fillCats();
});

/* ---------- adding photos: picker, paste, drag and drop ---------- */
button('pick').onclick = () => input('file').click();
input('file').onchange = () => { const f = input('file'); addFiles(f.files ?? []); f.value = ''; };
document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.items ?? [])].filter(it => it.kind === 'file').map(it => it.getAsFile());
  if (files.length) { e.preventDefault(); addFiles(files); }
});
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('drop').classList.add('over'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('over'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.remove('over');
  addFiles(e.dataTransfer?.files ?? []);
});
button('clear').onclick = () => { clearPhotos(); say(''); };

/* ---------- startup: desktop (local folders) or phone (Google Drive) ---------- */
function startDesktop(): void {
  idbGet<FileSystemDirectoryHandle>('dir').then(h => {
    if (h) { saveFolder = new LocalFolder(h); showFolder(); void refreshFromFolder(); }
  }).catch(() => {});
  idbGet<FileSystemDirectoryHandle>('src').then(h => {
    if (h) { sourceFolder = h; void loadRecent(); }
  }).catch(() => {});
  button('chooseFolder').onclick = async () => {
    try {
      const h = await showDirectoryPicker({ id: 'furniture', mode: 'readwrite' });
      saveFolder = new LocalFolder(h);
      await idbPut('dir', h).catch(() => {});
      showFolder(); void refreshFromFolder();
    } catch (e) { if (!isAbort(e)) say(errorText(e), 'err'); }
  };
  // Chrome blocks the root Downloads folder, so the user picks a subfolder
  button('recentPick').onclick = async () => {
    try {
      sourceFolder = await showDirectoryPicker({ id: 'recent-src', mode: 'read', startIn: 'downloads' });
      await idbPut('src', sourceFolder).catch(() => {});
      void loadRecent();
    } catch (e) { if (!isAbort(e)) say(errorText(e), 'err'); }
  };
  button('recentRefresh').onclick = () => void loadRecent();
  window.addEventListener('focus', () => { if (sourceFolder) void loadRecent(); });
}

function startPhone(): void {
  document.body.classList.add('phone');
  $('recent').hidden = true; $('dropHint').hidden = true;
  const dropTitle = $('drop').querySelector('strong');
  if (dropTitle) dropTitle.textContent = 'Add photos';
  $('pick').textContent = 'Take or choose photos';
  $('folderLabel').textContent = 'Save folder (Google Drive)';
  $('folderHint').textContent = 'Pick the Drive folder that your computer syncs. Photos go into a subfolder per category (like Living), with a small .txt per piece.';
  loadSignInScript();
  const stored = readJson('driveDir');
  if (stored && typeof stored === 'object' && 'id' in stored && 'name' in stored && typeof stored.id === 'string' && stored.id && typeof stored.name === 'string') {
    saveFolder = new DriveFolder(stored.id, stored.name); showFolder(); void refreshFromFolder();
  }

  const driveMsg = (t: string, cls: Status = ''): void => { const m = $('driveMsg'); m.textContent = t; m.className = 'msg ' + cls; };
  button('chooseFolder').onclick = async () => {
    try { if (!signedIn()) await signIn(); } catch (e) { say(errorText(e), 'err'); return; }
    $('driveResults').innerHTML = ''; driveMsg(''); dialog('driveDialog').showModal(); input('driveQuery').focus();
  };
  function useFolder(f: FolderMatch): void {
    saveFolder = new DriveFolder(f.id, f.name);
    prefs.set('driveDir', JSON.stringify({ id: f.id, name: f.name }));
    dialog('driveDialog').close(); showFolder(); void refreshFromFolder();
  }
  async function searchFolders(): Promise<void> {
    const q = input('driveQuery').value.trim();
    if (!q) return;
    $('driveResults').innerHTML = ''; driveMsg('Searching…');
    try {
      const found = await findDriveFolders(q);
      driveMsg(found.length ? '' : 'No folders match.', found.length ? '' : 'err');
      for (const f of found) {
        const li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `${escapeHtml(f.name)}${f.where ? `<small>in ${escapeHtml(f.where)}</small>` : ''}`;
        b.onclick = () => useFolder(f);
        li.appendChild(b); $('driveResults').appendChild(li);
      }
    } catch (e) { driveMsg(errorText(e), 'err'); }
  }
  button('driveSearch').onclick = () => void searchFolders();
  input('driveQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void searchFolders(); } });
}

if (LOCAL) startDesktop(); else startPhone();
fillCats(); fillLists(); showRating(); render();
