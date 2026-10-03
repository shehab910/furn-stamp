/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const idb = (mode, fn) => new Promise((res,rej)=>{
  const o=indexedDB.open('furniture-stamp',1);
  o.onupgradeneeded=()=>o.result.createObjectStore('kv');
  o.onerror=()=>rej(o.error);
  o.onsuccess=()=>{ const tx=o.result.transaction('kv',mode); const r=fn(tx.objectStore('kv')); tx.oncomplete=()=>res(r?.result); tx.onerror=()=>rej(tx.error); };
});
const newId = () => Math.random().toString(36).slice(2,6).padEnd(4,'0');

/* ---------- state ---------- */
const fields = ['category','item','store','price','dims','notes','rating'];
let photos = [];          // {id, file, url, status, cls, existing?, name?}
let selected = 0, busy = false;
let batchId = newId();
let edit = null;          // {folder, base, existing, metaName, maxNum}
let saveFolder = null;
const LOCAL = 'showDirectoryPicker' in window;   // desktop Chrome/Edge: local folder; phones: Google Drive

function info(){ const o={}; fields.forEach(f=>o[f]=$(f).value.trim()); o.seen=$('seen').checked?'yes':'no'; return o; }
function say(text, cls=''){ const m=$('msg'); m.textContent=text; m.className='msg '+cls; }

/* ---------- naming ---------- */
const baseName = i => pieceBase(i.category, batchId);
function nameFor(idx){
  const fresh = photos.filter(p=>!p.existing);
  const k = photos.slice(0,idx).filter(p=>!p.existing).length;
  return edit ? fileName(edit.base, edit.maxNum + k, edit.maxNum + fresh.length)
              : fileName(baseName(info()), k, fresh.length);
}

/* ---------- edit rules ---------- */
// Filled fields of a saved piece are locked; empty ones get overlaid when filled.
// Rating and seen IRL can always change and are always redrawn.
const lockedIn = (saved, f) => f!=='rating' && !!saved[f];
const newKeys = (saved, i) => SLOT_KEYS.filter(k => !saved[k] && i[k]);
function editChanges(saved, i){
  return { keys:newKeys(saved,i), rating:ratingOf(i.rating)!==ratingOf(saved.rating), seen:seenOf(i.seen)!==seenOf(saved.seen) };
}
function mergedInfo(saved, i){
  const m={...saved};
  fields.forEach(f=>{ if(!m[f] && i[f]) m[f]=i[f]; });
  m.rating = String(ratingOf(i.rating));
  m.seen = i.seen;
  return m;
}
// new photos get the full stamp; saved ones only what changed
function planFor(p, i){
  const keys = p.existing ? newKeys(edit.existing, i) : SLOT_KEYS;
  return { full:!p.existing, slots:Object.fromEntries(keys.map(k=>[k,i[k]])), rating:ratingOf(i.rating), seen:seenOf(i.seen) };
}

const mb = b => (b.size/1048576).toFixed(1)+' MB';

/* ---------- categories ---------- */
const DEFAULT_CATS = ['Dining','Bedroom','Living','Tables'];
let cats = (()=>{ try{ return JSON.parse(prefs.get('categories:v2')) || DEFAULT_CATS }catch{ return DEFAULT_CATS } })();
const fillCats = () => { $('catList').innerHTML = cats.map(c=>`<option value="${escapeHtml(c)}">`).join(''); };

/* ---------- autofill history ---------- */
let records = (()=>{ try{ return JSON.parse(prefs.get('records')) || [] }catch{ return [] } })();
const recKey = r => (r.item+'|'+(r.store||'')).toLowerCase();
function mergeRecords(list){
  const map = new Map(records.map(r=>[recKey(r),r]));
  list.forEach(r=>{ if(r?.item){ const k=recKey(r); map.set(k,{...map.get(k),...r}); } });
  records = [...map.values()].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  prefs.set('records', JSON.stringify(records.slice(0,500)));
  fillLists();
}
function fillLists(){
  const uniq = k => [...new Set(records.map(r=>r[k]).filter(Boolean))];
  const opts = a => a.map(v=>`<option value="${escapeHtml(v)}">`).join('');
  $('itemList').innerHTML=opts(uniq('item')); $('storeList').innerHTML=opts(uniq('store')); $('dimsList').innerHTML=opts(uniq('dims'));
}
function autofillFromItem(){
  const v=$('item').value.trim().toLowerCase(); if(!v) return;
  const st=$('store').value.trim().toLowerCase();
  const r = records.find(r=>r.item.toLowerCase()===v && (!st || (r.store||'').toLowerCase()===st)) || records.find(r=>r.item.toLowerCase()===v);
  if(!r) return;
  ['category','store','price','dims','notes'].forEach(k=>{ const el=$(k); if(!el.readOnly && !el.value.trim() && r[k]) el.value=r[k]; });
  render(); schedulePreview();
}

/* ---------- UI ---------- */
function render(){
  const i=info(), n=photos.length, fresh=photos.filter(p=>!p.existing).length;
  if (edit){
    const c=editChanges(edit.existing,i), nk=c.keys.length;
    const parts=[nk?`${nk} new field${nk>1?'s':''}`:'', c.rating?'new rating':'', c.seen?'seen IRL change':''].filter(Boolean);
    $('fnPreview').innerHTML = `Editing <b>${escapeHtml(edit.base)}</b>: ${parts.length ? parts.join(', ')+' to overlay' : 'change the rating or seen IRL, or fill an empty field'}${fresh?`, ${fresh} new photo${fresh>1?'s':''}`:''}.`;
  } else {
    $('fnPreview').innerHTML = `File names: <b>${escapeHtml(fileName(baseName(i),0,Math.max(fresh,1)))}</b>` + (fresh>1 ? ` … <b>_${String(fresh).padStart(Math.max(2,String(fresh).length),'0')}</b>` : '');
  }
  const ol=$('thumbs'); ol.innerHTML='';
  photos.forEach((p,idx)=>{
    const li=document.createElement('li');
    li.className = idx===selected ? 'sel' : ''; li.tabIndex=0;
    const name = p.existing ? p.name : nameFor(idx);
    li.innerHTML = `<img alt="" src="${p.url}"><div class="meta"><span class="tag">${p.existing?'saved':'new'}</span>${escapeHtml(name)}<span class="st ${p.cls||''}">${escapeHtml(p.status||'')}</span></div>` +
      (p.existing ? '' : `<button class="rm" type="button" aria-label="Remove photo">×</button>`);
    li.addEventListener('click', e=>{
      if (e.target.closest('.rm')) { removePhoto(idx); return; }
      selected=idx; render(); schedulePreview();
    });
    li.addEventListener('keydown', e=>{ if(e.key==='Enter'){ selected=idx; render(); schedulePreview(); } });
    ol.appendChild(li);
  });
  $('save').textContent = edit ? 'Apply to piece' : 'Save to folder';
  $('save').disabled = busy || !i.category || !saveFolder || (!edit && !n);
  $('download').disabled = busy || !n || !i.category || !!edit;
  $('clear').hidden = !!edit;
  $('clear').disabled = busy || !n;
  $('editBtn').textContent = edit ? 'Cancel edit' : LOCAL ? 'Edit a saved piece' : 'Edit from gallery';
  $('editBtn').disabled = busy;
  $('editBanner').hidden = !edit;
  if (edit) $('editBanner').textContent = 'Edit mode: filled fields are locked. Empty ones get overlaid onto the saved photos. Rating and seen IRL can always change.';
}

let pvTimer;
function schedulePreview(){ clearTimeout(pvTimer); pvTimer=setTimeout(drawPreview,250); }
async function drawPreview(){
  const box=$('preview'), p=photos[selected];
  if(!p){ box.innerHTML=''; return; }
  let c=box.querySelector('canvas');
  if(!c){ c=document.createElement('canvas'); box.innerHTML=''; box.appendChild(c); }
  try{ await renderPlan(p.file, planFor(p, info()), c); }
  catch{ p.status="Can't read this format"; p.cls='err'; render(); }
}
const fileKey = f => `${f.name}|${f.size}|${f.lastModified}`;
function addFiles(files){
  const imgs=[...files].filter(f=>f && f.type.startsWith('image/'));
  if(!imgs.length) return;
  imgs.forEach(f=>photos.push({id:crypto.randomUUID(), file:f, url:URL.createObjectURL(f), status:'', cls:''}));
  say(''); render(); schedulePreview(); syncRecentMarks();
}
function removePhoto(idx){
  URL.revokeObjectURL(photos[idx].url);
  photos.splice(idx,1);
  selected=Math.min(selected, Math.max(0,photos.length-1));
  render(); schedulePreview(); syncRecentMarks();
}
function clearPhotos(){
  photos.forEach(p=>URL.revokeObjectURL(p.url));
  photos=[]; selected=0; batchId=newId();
  render(); drawPreview(); syncRecentMarks();
}

/* ---------- save folder ---------- */
function showFolder(){ $('folderName').textContent = saveFolder ? saveFolder.name : 'No folder chosen'; render(); }
async function refreshFromFolder(){
  try{ if (await saveFolder?.allowed()) mergeRecords((await listPieces(saveFolder)).map(p=>p.meta)); }catch{}
}

async function saveNew(){
  const i=info(), n=photos.length;
  const base=baseName(i);
  const folder=await categoryFolder(saveFolder, i.category);
  const c=document.createElement('canvas'); let saved=0;
  for(let k=0;k<n;k++){
    const p=photos[k];
    try{
      p.status='Stamping…'; p.cls=''; render();
      const blob=await stampedJpeg(p.file,planFor(p,i),c);
      await folder.write(fileName(base,k,n), blob);
      p.status=`Saved (${mb(blob)})`; p.cls='ok'; saved++;
    }catch(e){ p.status = e instanceof DriveError ? e.message : "Can't read this format"; p.cls='err'; }
    render();
  }
  await folder.write(`${base}.txt`,infoText({...i, date:today()}));
  mergeRecords([{...i, date:today()}]);
  const where=`${saveFolder.name}/${folder.name}`;
  if(saved===n){ resetForm(); clearPhotos(); say(`Saved ${n} photo${n>1?'s':''} to ${where}.`,'ok'); }
  else say(`Saved ${saved} of ${n}. Check the photos marked in red.`,'err');
}

async function applyEdit(){
  const i=info(), ch=editChanges(edit.existing,i);
  const fresh=photos.filter(p=>!p.existing);
  const overlay = ch.keys.length || ch.rating || ch.seen;
  if(!overlay && !fresh.length){ say('Nothing new to add. Change the rating or seen IRL, fill an empty field, or drop new photos.','err'); return; }
  const c=document.createElement('canvas'); let failed=0;
  for(let idx=0; idx<photos.length; idx++){
    const p=photos[idx];
    if (p.existing && !overlay) continue;
    try{
      p.status = p.existing ? 'Overlaying…' : 'Stamping…'; p.cls=''; render();
      const blob = await (p.existing ? overlayJpeg : stampedJpeg)(p.file, planFor(p,i), c);
      await edit.folder.write(p.existing ? p.name : nameFor(idx), blob);
      p.status='Updated'; p.cls='ok';
    }catch(e){ p.status = e instanceof DriveError ? e.message : 'Failed'; p.cls='err'; failed++; }
    render();
  }
  const merged=mergedInfo(edit.existing,i);
  await edit.folder.write(edit.metaName,infoText(merged));
  mergeRecords([merged]);
  if(!failed){ const b=edit.base; exitEdit(); say(`Updated ${b}.`,'ok'); }
  else say(`${failed} photo${failed>1?'s':''} failed. Check the ones marked in red.`,'err');
}

async function enterEdit(){
  if(!LOCAL){ showView('gallery'); return; }
  if(!saveFolder){ say('Choose your save folder first.','err'); return; }
  if(!await saveFolder.allowed(true)){ say('Folder access was denied.','err'); return; }
  if(photos.length && !confirm('Discard the photos in the current batch?')) return;
  let fh;
  try{ [fh] = await showOpenFilePicker({startIn:saveFolder.h, types:[{description:'Saved photos', accept:{'image/jpeg':['.jpg','.jpeg']}}]}); }
  catch(e){ if(e.name!=='AbortError') say(e.message,'err'); return; }
  const at = await saveFolder.locate(fh);
  if(!at){ say(`Pick a photo from inside ${saveFolder.name}.`,'err'); return; }
  const m = at.name.match(PHOTO_RE);
  if(!m){ say("That file name doesn't follow the naming pattern.",'err'); return; }
  await loadEdit(at.folder, m[1]);
}
async function loadEdit(folder, base){
  const {meta, metaName, photos:files} = await loadPiece(folder, base);
  if(!meta || !EDITABLE.includes(meta.layout)){ say("This piece was saved before the fixed layout, so its empty slots are unknown. Only pieces saved from now on can be edited.",'err'); return; }
  clearPhotos();
  edit={folder, base, existing:meta, metaName, maxNum:Math.max(0,...files.map(f=>f.num))};
  fields.forEach(f=>{ $(f).value=meta[f]||''; $(f).readOnly=lockedIn(meta,f); });
  $('seen').checked = seenOf(meta.seen);
  showRating();
  photos=files.map(f=>({id:crypto.randomUUID(), file:f.file, url:URL.createObjectURL(f.file), name:f.name, existing:true, status:'', cls:''}));
  selected=0;
  say(`Loaded ${files.length} photo${files.length>1?'s':''}.`);
  render(); schedulePreview();
}
function resetForm(){
  fields.forEach(f=>{ $(f).readOnly=false; $(f).value=''; });
  $('seen').checked = false;
  showRating();
}
function exitEdit(){
  edit=null;
  resetForm();
  clearPhotos();
}

$('save').onclick = async ()=>{
  const i=info();
  if(!i.category){ say('Add a category first.','err'); $('category').focus(); return; }
  busy=true; render();
  try{
    if(!await saveFolder.allowed(true)) throw new Error('Folder access was denied. Choose the folder again.');
    edit ? await applyEdit() : await saveNew();
  }catch(e){ say(e.message,'err'); }
  finally{ busy=false; render(); }
};
$('editBtn').onclick = ()=>{ if(edit){ exitEdit(); say(''); } else enterEdit(); };

/* ---------- download ---------- */
$('download').onclick = async ()=>{
  busy=true; render();
  const i=info(), n=photos.length, base=baseName(i), c=document.createElement('canvas');
  let failed=0;
  for(let k=0;k<n;k++){
    try{
      const blob=await stampedJpeg(photos[k].file,planFor(photos[k],i),c);
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download=fileName(base,k,n);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href),4000);
      await new Promise(r=>setTimeout(r,300));
    }catch{ photos[k].status="Can't read this format"; photos[k].cls='err'; failed++; }
  }
  mergeRecords([{...i, date:today()}]);
  busy=false;
  if(!failed){ clearPhotos(); say(`Downloaded ${n} photo${n>1?'s':''}.`,'ok'); }
  else { render(); say(`Downloaded ${n-failed} of ${n}. Check the photos marked in red.`,'err'); }
};

/* ---------- recent photos strip ---------- */
let srcHandle=null, recentUrls=[];
const IMG_EXT=/\.(jpe?g|png|webp|gif|bmp|avif)$/i;
function ago(t){
  const m=Math.round((Date.now()-t)/60000);
  if(m<1) return 'just now'; if(m<60) return `${m} min ago`;
  const h=Math.round(m/60); return h<24 ? `${h} h ago` : `${Math.round(h/24)} d ago`;
}
function syncRecentMarks(){
  const added=new Set(photos.map(p=>fileKey(p.file)));
  document.querySelectorAll('#recentList button').forEach(b=>b.classList.toggle('added', added.has(b.dataset.key)));
}
async function loadRecent(){
  const list=$('recentList');
  if(!srcHandle){ list.innerHTML=''; return; }
  $('recentTitle').textContent=`Recent in ${srcHandle.name}`;
  $('recentPick').textContent='Change folder';
  if(await srcHandle.queryPermission({mode:'read'})!=='granted'){
    $('recentHint').innerHTML='<button class="linkbtn" id="recentAllow" type="button">Allow access</button> to show the latest photos.';
    $('recentHint').hidden=false; list.innerHTML='';
    $('recentAllow').onclick=async()=>{ if(await srcHandle.requestPermission({mode:'read'})==='granted') loadRecent(); };
    return;
  }
  const files=[];
  for await (const [name,h] of srcHandle.entries())
    if(h.kind==='file' && IMG_EXT.test(name)){ try{ files.push({h, f:await h.getFile()}); }catch{} }
  files.sort((a,b)=>b.f.lastModified-a.f.lastModified);
  const top=files.slice(0,5);
  recentUrls.forEach(URL.revokeObjectURL); recentUrls=[];
  $('recentRefresh').hidden=false;
  $('recentHint').hidden=top.length>0; $('recentHint').textContent='No photos in this folder yet.';
  list.innerHTML='';
  top.forEach(({f})=>{
    const url=URL.createObjectURL(f); recentUrls.push(url);
    const li=document.createElement('li'), b=document.createElement('button');
    b.type='button'; b.title=f.name; b.dataset.key=fileKey(f);
    b.innerHTML=`<img alt="" src="${url}"><small>${escapeHtml(ago(f.lastModified))}</small>`;
    b.onclick=()=>{
      const idx=photos.findIndex(p=>fileKey(p.file)===b.dataset.key);
      if(idx>=0){ if(!photos[idx].existing) removePhoto(idx); } else addFiles([f]);
    };
    li.appendChild(b); list.appendChild(li);
  });
  syncRecentMarks();
}

/* ---------- gallery ---------- */
let pieces=[], thumbObs=null, galleryTiles=[], lbIndex=0;
const parsePrice = s => {
  if(!s) return null;
  const t = s.replace(/[٠-٩]/g, d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,\s]/g,'');
  const m = t.match(/\d+(\.\d+)?/);
  if(!m) return null;
  let v = +m[0];
  if (/^\d+(\.\d+)?k/i.test(t.slice(m.index))) v *= 1000;   // "24.5k"
  return v;
};
function fillSelect(id, label, values){
  const el=$(id), cur=el.value;
  el.innerHTML = `<option value="">${label}</option>` + values.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  el.value = values.includes(cur) ? cur : '';
}
async function loadGallery(){
  $('gGrid').innerHTML='';
  if(!saveFolder){ $('gCount').textContent='Choose your save folder on the Stamp tab first.'; return; }
  if(!await saveFolder.allowed()){
    $('gCount').innerHTML='<button class="linkbtn" id="gAllow" type="button">Allow folder access</button> to show your pieces.';
    $('gAllow').onclick=async()=>{ if(await saveFolder.allowed(true)) loadGallery(); };
    return;
  }
  $('gCount').textContent='Scanning…';
  pieces.forEach(p=>p.files.forEach(f=>{ if(f.url) URL.revokeObjectURL(f.url); if(f.thumbUrl && f.thumbUrl!==f.url) URL.revokeObjectURL(f.thumbUrl); }));
  pieces = (await listPieces(saveFolder)).map(p=>({...p, files:p.photos, count:p.photos.length,
    price:parsePrice(p.meta.price), rating:ratingOf(p.meta.rating), date:p.meta.date||'', editable:EDITABLE.includes(p.meta.layout)}));
  const uniq = k => [...new Set(pieces.map(p=>p.meta[k]).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  fillSelect('gCat','All categories',[...new Set([...cats, ...uniq('category')])]);
  fillSelect('gStore','All stores',uniq('store'));
  renderGallery();
}
function renderGallery(){
  const q=$('gSearch').value.trim().toLowerCase(), cat=$('gCat').value, st=$('gStore').value;
  const min=$('gMin').value===''?null:+$('gMin').value, max=$('gMax').value===''?null:+$('gMax').value;
  const rf=$('gRating').value, sf=$('gSeen').value, sort=$('gSort').value;
  let list = pieces.filter(p=>{
    const m=p.meta;
    if (cat && m.category!==cat) return false;
    if (st && m.store!==st) return false;
    if ((min!==null || max!==null) && p.price===null) return false;
    if (min!==null && p.price<min) return false;
    if (max!==null && p.price>max) return false;
    if (rf==='0' && p.rating!==0) return false;
    if (rf && rf!=='0' && p.rating < +rf) return false;
    if (sf && seenOf(m.seen) !== (sf==='yes')) return false;
    if (q && !`${m.item||''} ${m.notes||''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const byPrice = dir => (a,b)=> (a.price===null) - (b.price===null) || dir*((a.price??0)-(b.price??0));
  list.sort({
    new:(a,b)=>(b.date||b.base).localeCompare(a.date||a.base),
    priceAsc:byPrice(1), priceDesc:byPrice(-1),
    rating:(a,b)=>b.rating-a.rating
  }[sort]);
  const tiles = list.flatMap(p=>p.files.map((f,k)=>({p,f,k})));
  galleryTiles = tiles;
  const all = pieces.reduce((n,p)=>n+p.count,0);
  $('gCount').textContent = `${tiles.length} of ${all} photo${all===1?'':'s'} (${list.length} of ${pieces.length} piece${pieces.length===1?'':'s'})`;
  thumbObs?.disconnect();
  thumbObs = new IntersectionObserver(async entries=>{
    for (const e of entries){
      if(!e.isIntersecting) continue;
      thumbObs.unobserve(e.target);
      const f=tiles[+e.target.dataset.i].f;
      try{ f.thumbUrl ??= f.thumb ? URL.createObjectURL(await f.thumb()) : (f.url ??= URL.createObjectURL(await f.read())); e.target.src=f.thumbUrl; }catch{}
    }
  }, {rootMargin:'200px'});
  const grid=$('gGrid'); grid.innerHTML='';
  tiles.forEach(({p,f,k},ti)=>{
    const m=p.meta, li=document.createElement('li');
    const stars = '<b>'+'★'.repeat(p.rating)+'</b>'+'★'.repeat(5-p.rating);
    const sub = [m.category, m.store].filter(Boolean).map(escapeHtml).join(' | ');
    li.innerHTML = `<div class="card">
      <button class="open" type="button" aria-label="Expand photo"><img class="ph" alt="" data-i="${ti}"></button>
      <div class="body">
        <div class="t">${escapeHtml(m.item || m.category || p.base)}</div>
        <div class="m">${sub}${m.price?`${sub?' | ':''}<span class="price">${escapeHtml(m.price)}</span>`:''}${m.dims?` | ${escapeHtml(m.dims)}`:''}</div>
        <div class="r"><span aria-label="${p.rating} of 5 stars">${stars}</span>${seenOf(m.seen)?'<span class="seen">✓ Seen IRL</span>':''}</div>
      </div>
      <div class="foot">
        <span>Photo ${k+1} of ${p.count}${m.date?` | ${escapeHtml(m.date)}`:''}${p.editable?'':' | older layout'}</span>
        ${p.editable?`<button class="iconbtn" type="button" aria-label="Edit this piece" title="Edit piece"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>`:''}
      </div></div>`;
    li.querySelector('.open').onclick=()=>openViewer(ti);
    li.querySelector('.iconbtn')?.addEventListener('click',()=>openPiece(p, f.name));
    thumbObs.observe(li.querySelector('img'));
    grid.appendChild(li);
  });
  if(!tiles.length && pieces.length) $('gCount').textContent += '. Nothing matches these filters.';
}
async function openPiece(p, photoName){
  if(!p.editable){ say('',''); alert('This piece was saved with an older layout, so it can\u2019t be edited.'); return; }
  if(photos.length && !edit && !confirm('Discard the photos in the current batch?')) return;
  showView('stamp');
  await loadEdit(p.folder, p.base);
  const idx = photos.findIndex(x=>x.name===photoName);
  if(idx>=0){ selected=idx; render(); schedulePreview(); }
}
async function showViewer(){
  const t=galleryTiles[lbIndex]; if(!t) return;
  const m=t.p.meta;
  try{ t.f.url ??= URL.createObjectURL(await t.f.read()); $('lbImg').src=t.f.url; }catch{}
  $('lbImg').alt = m.item || m.category || '';
  $('lbCaption').textContent = `${[m.item, m.store, m.price].filter(Boolean).join(' | ') || m.category || t.p.base}  (${lbIndex+1} / ${galleryTiles.length})`;
  $('lbPrev').disabled = lbIndex===0; $('lbNext').disabled = lbIndex===galleryTiles.length-1;
}
function openViewer(i){ lbIndex=i; $('lightbox').showModal(); showViewer(); }
function stepViewer(d){ const n=lbIndex+d; if(n>=0 && n<galleryTiles.length){ lbIndex=n; showViewer(); } }
$('lbClose').onclick=()=>$('lightbox').close();
$('lbPrev').onclick=()=>stepViewer(-1);
$('lbNext').onclick=()=>stepViewer(1);
$('lightbox').addEventListener('keydown',e=>{
  if(e.key==='ArrowLeft'){ e.preventDefault(); stepViewer(-1); }
  if(e.key==='ArrowRight'){ e.preventDefault(); stepViewer(1); }
});
$('lightbox').addEventListener('click',e=>{ if(e.target.classList.contains('lb-stage')) $('lightbox').close(); });
let touchX=null;
$('lbImg').addEventListener('touchstart',e=>{ touchX=e.touches[0].clientX; },{passive:true});
$('lbImg').addEventListener('touchend',e=>{ if(touchX===null) return; const dx=e.changedTouches[0].clientX-touchX; if(Math.abs(dx)>50) stepViewer(dx<0?1:-1); touchX=null; });

function showView(v){
  const g = v==='gallery';
  $('stampView').hidden=g; $('galleryView').hidden=!g;
  $('tabStamp').setAttribute('aria-pressed',String(!g)); $('tabGallery').setAttribute('aria-pressed',String(g));
  if(g) loadGallery();
}
$('tabStamp').onclick=()=>showView('stamp');
$('tabGallery').onclick=()=>showView('gallery');
$('gRefresh').onclick=loadGallery;
['gSearch','gMin','gMax'].forEach(id=>$(id).addEventListener('input',renderGallery));
['gCat','gStore','gRating','gSeen','gSort'].forEach(id=>$(id).addEventListener('change',renderGallery));
$('gReset').onclick=()=>{ ['gSearch','gMin','gMax','gCat','gStore','gRating','gSeen'].forEach(id=>$(id).value=''); $('gSort').value='new'; renderGallery(); };

/* ---------- rating control ---------- */
function showRating(){
  const v=ratingOf($('rating').value);
  $('stars').querySelectorAll('button').forEach(b=>{
    const n=+b.dataset.v; b.classList.toggle('on', n<=v); b.setAttribute('aria-checked', String(n===v));
  });
}
$('stars').addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b) return;
  const n=+b.dataset.v;
  $('rating').value = String(ratingOf($('rating').value)===n ? 0 : n);   // click current rating again to clear
  showRating(); render(); schedulePreview();
});

/* ---------- bindings ---------- */
fields.forEach(f=>$(f).addEventListener('input',()=>{ render(); schedulePreview(); }));
$('seen').addEventListener('change',()=>{ render(); schedulePreview(); });
$('item').addEventListener('change', autofillFromItem);
['category','item','store','dims'].forEach(id=>{
  const el=$(id);
  el.addEventListener('keydown', e=>{
    if(e.key!=='Tab' || e.shiftKey || el.readOnly) return;
    const v=el.value.trim().toLowerCase(); if(!v) return;
    const opts=[...(el.list?.options||[])].map(o=>o.value);
    if(opts.some(o=>o.toLowerCase()===v)) return;
    const hit=opts.find(o=>o.toLowerCase().startsWith(v)) || opts.find(o=>o.toLowerCase().includes(v));
    if(!hit) return;
    el.value=hit; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
  });
});
$('editCats').onclick=()=>{ $('catText').value=cats.join('\n'); $('catDialog').showModal(); };
$('catDialog').addEventListener('close',()=>{
  if($('catDialog').returnValue!=='save') return;
  cats=[...new Set($('catText').value.split('\n').map(s=>s.trim()).filter(Boolean))];
  prefs.set('categories:v2',JSON.stringify(cats)); fillCats();
});
$('pick').onclick=()=>$('file').click();
$('file').onchange=e=>{ addFiles(e.target.files); e.target.value=''; };
document.addEventListener('paste',e=>{
  const files=[...(e.clipboardData?.items||[])].filter(it=>it.kind==='file').map(it=>it.getAsFile());
  if(files.length){ e.preventDefault(); addFiles(files); }
});
let dragDepth=0;
window.addEventListener('dragenter',e=>{ e.preventDefault(); dragDepth++; $('drop').classList.add('over'); });
window.addEventListener('dragleave',()=>{ if(--dragDepth<=0){ dragDepth=0; $('drop').classList.remove('over'); } });
window.addEventListener('dragover',e=>e.preventDefault());
window.addEventListener('drop',e=>{ e.preventDefault(); dragDepth=0; $('drop').classList.remove('over'); addFiles(e.dataTransfer.files); });
$('clear').onclick=()=>{ clearPhotos(); say(''); };

if(LOCAL){
  idb('readonly',st=>st.get('dir')).then(h=>{ if(h){ saveFolder=new LocalFolder(h); showFolder(); refreshFromFolder(); } }).catch(()=>{});
  idb('readonly',st=>st.get('src')).then(h=>{ if(h){ srcHandle=h; loadRecent(); } }).catch(()=>{});
  $('chooseFolder').onclick=async()=>{
    try{ const h=await showDirectoryPicker({id:'furniture',mode:'readwrite'}); saveFolder=new LocalFolder(h); await idb('readwrite',st=>st.put(h,'dir')).catch(()=>{}); showFolder(); refreshFromFolder(); }
    catch(e){ if(e.name!=='AbortError') say(e.message,'err'); }
  };
  $('recentPick').onclick=async()=>{
    try{ srcHandle=await showDirectoryPicker({id:'recent-src',mode:'read',startIn:'downloads'}); await idb('readwrite',st=>st.put(srcHandle,'src')).catch(()=>{}); loadRecent(); }
    catch(e){ if(e.name!=='AbortError') say(e.message,'err'); }
  };
  $('recentRefresh').onclick=loadRecent;
  window.addEventListener('focus',()=>{ if(srcHandle) loadRecent(); });
} else {
  document.body.classList.add('phone');
  $('recent').hidden=true; $('dropHint').hidden=true;
  $('drop').querySelector('strong').textContent='Add photos';
  $('pick').textContent='Take or choose photos';
  $('folderLabel').textContent='Save folder (Google Drive)';
  $('folderHint').textContent='Pick the Drive folder that your computer syncs. Photos go into a subfolder per category (like Living), with a small .txt per piece.';
  const gis=document.createElement('script'); gis.src='https://accounts.google.com/gsi/client'; gis.async=true; document.head.appendChild(gis);
  try{ const d=JSON.parse(prefs.get('driveDir')); if(d?.id){ saveFolder=new DriveFolder(d.id, d.name); showFolder(); refreshFromFolder(); } }catch{}

  const driveMsg = (t, cls='') => { $('driveMsg').textContent=t; $('driveMsg').className='msg '+cls; };
  $('chooseFolder').onclick=async()=>{
    try{ if(!tokenOk()) await driveSignIn(); }catch(e){ say(e.message,'err'); return; }
    $('driveResults').innerHTML=''; driveMsg(''); $('driveDialog').showModal(); $('driveQuery').focus();
  };
  function useFolder(f){
    saveFolder=new DriveFolder(f.id, f.name);
    prefs.set('driveDir', JSON.stringify({id:f.id, name:f.name}));
    $('driveDialog').close(); showFolder(); refreshFromFolder();
  }
  async function searchFolders(){
    const q=$('driveQuery').value.trim(); if(!q) return;
    $('driveResults').innerHTML=''; driveMsg('Searching…');
    try{
      const found = await findDriveFolders(q);
      driveMsg(found.length ? '' : 'No folders match.', found.length ? '' : 'err');
      found.forEach(f=>{
        const li=document.createElement('li'), b=document.createElement('button');
        b.type='button';
        b.innerHTML=`${escapeHtml(f.name)}${f.where?`<small>in ${escapeHtml(f.where)}</small>`:''}`;
        b.onclick=()=>useFolder(f);
        li.appendChild(b); $('driveResults').appendChild(li);
      });
    }catch(e){ driveMsg(e.message,'err'); }
  }
  $('driveSearch').onclick=searchFolders;
  $('driveQuery').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); searchFolders(); } });
}

fillCats(); fillLists(); showRating(); render();
