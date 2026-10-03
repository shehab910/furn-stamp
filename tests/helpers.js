const { expect } = require('@playwright/test');

const FOLDER = 'application/vnd.google-apps.folder';
const W = 1200, H = 900;

// A plain grey photo, so anything the stamp draws stands out.
async function makePhoto(page, color = '#808080') {
  const bytes = await page.evaluate(async ({ W, H, color }) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, W, H);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, { W, H, color });
  return { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(bytes) };
}

async function addPhoto(page, color) {
  await page.setInputFiles('#file', await makePhoto(page, color));
}

async function fillForm(page, f) {
  for (const k of ['category', 'item', 'store', 'price', 'dims', 'notes']) if (f[k] !== undefined) await page.fill(`#${k}`, f[k]);
  if (f.rating) await page.click(`#stars button[data-v="${f.rating}"]`);
  if (f.seen) await page.check('#seen');
}

async function clickSave(page) {
  await page.click('#save');
  await expect(page.locator('#msg')).toHaveClass(/ok|err/, { timeout: 20_000 });
  return page.locator('#msg').textContent();
}

/* ---------- desktop: the browser's private folder (OPFS) stands in for the picked save folder ---------- */
// Stubs the folder picker and goes through the real "Choose folder" button. (Reloading after that would
// read the handle back from IndexedDB, which crashes this Chromium build with OPFS handles, so tests don't.)
async function openWithLocalFolder(page) {
  await page.addInitScript(() => { window.showDirectoryPicker = () => navigator.storage.getDirectory(); });
  await page.goto('/index.html');
  await page.click('#chooseFolder');
  await expect(page.locator('#folderName')).not.toHaveText('No folder chosen');
}

// {"Dining/x.txt": bytes, ...} for every file in the local save folder
async function localFiles(page) {
  const files = await page.evaluate(async () => {
    const out = {};
    async function walk(dir, prefix) {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
        else out[prefix + name] = Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer()));
      }
    }
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  });
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}

/* ---------- phone: no folder access, plus an in-memory Google Drive behind the real API URLs ---------- */
async function openAsPhone(page, { folderChosen = true } = {}) {
  const drive = await fakeDrive(page.context());
  await page.context().addInitScript(chosen => {
    delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;
    localStorage.setItem('gtoken', JSON.stringify({ access_token: 'test', exp: Date.now() + 3600e3 }));
    if (chosen) localStorage.setItem('driveDir', JSON.stringify({ id: 'root', name: 'Furniture' }));
  }, folderChosen);
  await page.goto('/index.html');
  return drive;
}

async function fakeDrive(context) {
  const files = { root: { id: 'root', name: 'Furniture', mimeType: FOLDER, parents: ['mydrive'] }, mydrive: { id: 'mydrive', name: 'My Drive', mimeType: FOLDER, parents: [] } };
  const blobs = {}, sessions = {};
  let n = 0;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Location', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  const json = (route, body) => route.fulfill({ json: body, headers: cors });
  await context.route(/www\.googleapis\.com|accounts\.google\.com/, route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.host === 'accounts.google.com') return route.fulfill({ body: '', contentType: 'text/javascript' });
    if (url.pathname.startsWith('/upload/')) {        // resumable upload: start a session
      const id = url.pathname.split('/files/')[1] || `f${++n}`;
      sessions[id] = JSON.parse(req.postData() || '{}');
      return route.fulfill({ headers: { ...cors, Location: `https://www.googleapis.com/session/${id}?upload_id=1` }, body: '' });
    }
    if (url.pathname.startsWith('/session/')) {       // resumable upload: the bytes
      const id = url.pathname.split('/')[2];
      files[id] ??= { id, name: sessions[id].name, mimeType: req.headers()['content-type'], parents: sessions[id].parents };
      files[id].modifiedTime = new Date().toISOString();
      blobs[id] = req.postDataBuffer();
      return json(route, files[id]);
    }
    const id = url.pathname.split('/files/')[1];
    if (req.method() === 'POST') { const f = { id: `d${++n}`, ...JSON.parse(req.postData()) }; files[f.id] = f; return json(route, f); }
    if (id && url.searchParams.get('alt') === 'media') return route.fulfill({ body: blobs[id], contentType: files[id].mimeType, headers: cors });
    if (id) return json(route, files[id]);
    const q = url.searchParams.get('q');
    const parent = q.match(/^'([^']+)' in parents/)?.[1];
    const name = q.match(/name='((?:[^'\\]|\\.)*)'/)?.[1];
    const contains = q.match(/name contains '((?:[^'\\]|\\.)*)'/)?.[1];
    const list = Object.values(files).filter(f => f.id !== 'mydrive'
      && (!parent || f.parents?.includes(parent)) && (!name || f.name === name)
      && (!contains || f.name.toLowerCase().includes(contains.toLowerCase()))
      && (!/mimeType ?= ?'/.test(q) || f.mimeType === FOLDER) && (!/mimeType != '/.test(q) || f.mimeType !== FOLDER));
    return json(route, { files: list });
  });
  // {"Living/x.txt": bytes, ...} relative to the chosen root folder
  const pathOf = f => f.parents[0] === 'root' ? f.name : `${pathOf(files[f.parents[0]])}/${f.name}`;
  return {
    files: () => Object.fromEntries(Object.values(files).filter(f => blobs[f.id]).map(f => [pathOf(f), blobs[f.id]])),
    ids: () => Object.keys(blobs).sort(),
  };
}

/* ---------- checking the stamped image ---------- */
// Decodes a saved JPEG in the page and measures it against the app's own slot layout:
// how much white text sits in each slot, which stars are gold, and the seen IRL badge colour.
async function probe(page, jpeg) {
  return page.evaluate(async bytes => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const L = layout(c.width, c.height);   // stamp.js
    const px = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));
    const whiteShare = s => {
      const h = s.lines ? s.lh * s.lines : s.h;
      const d = ctx.getImageData(s.x, s.y, s.w, h).data;
      let white = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
      return white / (d.length / 4);
    };
    const gold = ([r, g, b]) => r > 200 && g > 160 && b < 110;
    const green = ([r, g, b]) => g > r + 40 && g > b + 20;
    const S = L.stars, r = S.size / 2;
    return {
      width: c.width, height: c.height,
      text: Object.fromEntries(Object.entries(L.slots).map(([k, s]) => [k, whiteShare(s) > 0.01])),
      stars: [0, 1, 2, 3, 4].filter(k => gold(px(S.x + k * (S.size + S.gap) + r, S.y + S.h / 2))).length,
      seen: green(px(L.seen.x + L.seen.h * 0.15, L.seen.y + L.seen.h / 2)),
      topBandDark: px(c.width - 3, 3).every(v => v < 80),
      bottomBandDark: px(c.width - 3, c.height - 3).every(v => v < 80),
    };
  }, Array.from(jpeg));
}

// Share of pixels that changed between two images, outside the given regions of the stamp layout.
async function changedOutside(page, before, after, regions) {
  return page.evaluate(async ({ a, b, regions }) => {
    const read = async bytes => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      return { d: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    };
    const A = await read(a), B = await read(b), L = layout(A.w, A.h);
    const pad = 4, boxes = regions.map(k => {
      const s = L.slots[k] || L[k];
      return { x0: s.x - pad, y0: s.y - pad, x1: s.x + (s.w ?? (s.size * 5 + s.gap * 4)) + pad, y1: s.y + (s.h ?? s.lh * s.lines) + pad };
    });
    let changed = 0, total = 0;
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
      if (boxes.some(q => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1)) continue;
      const i = (y * A.w + x) * 4; total++;
      if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]) > 30) changed++;
    }
    return changed / total;
  }, { a: Array.from(before), b: Array.from(after), regions });
}

// Lossless PNG of a saved JPEG, for golden snapshots.
async function toPng(page, jpeg) {
  const bytes = await page.evaluate(async b => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(b)], { type: 'image/jpeg' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const out = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await out.arrayBuffer()));
  }, Array.from(jpeg));
  return Buffer.from(bytes);
}

module.exports = { W, H, addPhoto, fillForm, clickSave, openWithLocalFolder, localFiles, openAsPhone, probe, changedOutside, toPng };
