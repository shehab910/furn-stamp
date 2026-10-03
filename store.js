// The piece store: how pieces are named, saved and found, on either kind of save folder.
// A piece is a category subfolder holding base_NN.jpg photos plus a base.txt sidecar.
// Folder adapters share one small interface: name, list(), sub(name, create), write(name, data), allowed(ask).
const prefs = {
  get(k,d=''){ try{ return localStorage.getItem(k) ?? d }catch{ return d } },
  set(k,v){ try{ localStorage.setItem(k,v) }catch{} }
};

/* ---------- naming: category_date_id_NN.jpg ---------- */
const today = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` };
const slug = s => (s||'').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,40);
const folderFor = c => (c||'').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]+/g,' ').replace(/\s+/g,' ').replace(/^[\s.]+|[\s.]+$/g,'').slice(0,60) || 'Other';
const pieceBase = (category, id) => [slug(category)||'category', today(), id].join('_');
const fileName = (base, idx, total) => `${base}_${String(idx+1).padStart(Math.max(2,String(total).length),'0')}.jpg`;
const PHOTO_RE = /^(.+)_(\d+)\.jpe?g$/i;

/* ---------- sidecar .txt ---------- */
const LAYOUT = '4';                       // 4: narrower item slot to fit the seen IRL badge
const EDITABLE = ['3', LAYOUT];         // 3 pieces get the badge over the end of the item row
const OUT_LABELS = [['layout','Layout'],['category','Category'],['item','Item'],['store','Store'],['price','Price'],['dims','Size'],['rating','Rating'],['seen','Seen'],['date','Date'],['notes','Description']];
const IN_LABELS = Object.fromEntries([...OUT_LABELS.map(([k,l])=>[l,k]), ['Notes','notes']]);
function infoText(v){
  return OUT_LABELS.map(([k,l])=>{ const x = k==='layout' ? (v.layout||LAYOUT) : v[k]; return x ? `${l}: ${x}` : ''; }).filter(Boolean).join('\n')+'\n';
}
function parseInfo(txt){
  const r={}; let inNotes=false;
  for (const line of txt.split(/\r?\n/)){
    const m = !inNotes && line.match(/^(\w+):\s*(.*)$/);
    const key = m && IN_LABELS[m[1]];
    if (key){ r[key]=m[2]; inNotes = key==='notes'; }
    else if (inNotes) r.notes += '\n'+line;
  }
  if (r.notes) r.notes = r.notes.trim();
  return Object.keys(r).length ? r : null;
}
const seenOf = v => v==='yes';
const ratingOf = v => Math.max(0, Math.min(5, parseInt(v,10) || 0));

/* ---------- pieces ---------- */
const categoryFolder = (root, category) => root.sub(folderFor(category), true);
const readInfo = async e => parseInfo(await (await e.read()).text());

// every piece under root (category subfolders, plus older Category/piece/info.txt ones)
async function listPieces(root){
  const out=[];
  async function walk(folder, depth){
    const groups=new Map(), txts=new Map();
    for (const e of await folder.list()){
      if (e.kind==='dir'){ if(depth<2) await walk(e.folder, depth+1); continue; }
      const m = e.name.match(PHOTO_RE);
      if (m){ if(!groups.has(m[1])) groups.set(m[1],[]); groups.get(m[1]).push(e); }
      else if (e.name.endsWith('.txt')) txts.set(e.name, e);
    }
    await Promise.all([...groups].map(async ([base,photos])=>{
      const t = txts.get(`${base}.txt`) || (groups.size===1 ? txts.get('info.txt') : null);
      if (!t) return;
      photos.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
      out.push({folder, base, meta:await readInfo(t) || {}, photos});
    }));
  }
  await walk(root, 0);
  return out;
}
// one piece's sidecar and its photos, in number order
async function loadPiece(folder, base){
  let meta=null, metaName=null; const photos=[];
  for (const e of await folder.list()){
    if (e.kind!=='file') continue;
    if (e.name===`${base}.txt` || (e.name==='info.txt' && !metaName)){ meta=await readInfo(e); metaName=e.name; continue; }
    const m = e.name.match(PHOTO_RE);
    if (m && m[1].toLowerCase()===base.toLowerCase()) photos.push({name:e.name, num:+m[2], file:await e.read()});
  }
  photos.sort((a,b)=>a.num-b.num);
  return {meta, metaName, photos};
}

/* ---------- local folder (desktop Chrome/Edge) ---------- */
class LocalFolder {
  constructor(h){ this.h=h; this.name=h.name; }
  async allowed(ask=false){
    if (await this.h.queryPermission({mode:'readwrite'})==='granted') return true;
    return ask && (await this.h.requestPermission({mode:'readwrite'}))==='granted';
  }
  async list(){
    const out=[];
    for await (const [name,h] of this.h.entries())
      out.push(h.kind==='directory' ? {name, kind:'dir', folder:new LocalFolder(h)} : {name, kind:'file', read:()=>h.getFile()});
    return out;
  }
  async sub(name, create=false){ return new LocalFolder(await this.h.getDirectoryHandle(name,{create})); }
  async write(name, data){
    const fh=await this.h.getFileHandle(name,{create:true});
    const w=await fh.createWritable(); await w.write(data); await w.close();
  }
  // the folder and name of a file picked from inside this folder, or null
  async locate(fileHandle){
    const path = await this.h.resolve(fileHandle);
    if (!path) return null;
    let folder=this;
    for (const part of path.slice(0,-1)) folder=await folder.sub(part);
    return {folder, name:path.at(-1)};
  }
}

/* ---------- Google Drive folder (phones) ---------- */
// Mobile browsers can't open local folders, so phones reach the same synced folder through the Drive API.
const GOOGLE_CLIENT_ID = '';   // OAuth web client ID from Google Cloud; only phones need it
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,thumbnailLink,parents';
class DriveError extends Error { constructor(m){ super(m); this.name='DriveError'; } }
let gToken = (()=>{ try{ return JSON.parse(prefs.get('gtoken')) }catch{ return null } })();
let tokenClient = null;
const tokenOk = () => !!gToken && Date.now() < gToken.exp - 60000;
const EXPIRED = 'Google Drive sign-in expired. Tap again to reconnect.';
function driveSignIn(){
  return new Promise((res,rej)=>{
    if(!GOOGLE_CLIENT_ID) return rej(new DriveError('Google sign-in isn’t set up yet: GOOGLE_CLIENT_ID is empty.'));
    if(!window.google?.accounts?.oauth2) return rej(new DriveError('Google sign-in is still loading. Try again in a moment.'));
    tokenClient ??= google.accounts.oauth2.initTokenClient({client_id:GOOGLE_CLIENT_ID, scope:'https://www.googleapis.com/auth/drive', callback:()=>{}});
    tokenClient.callback = r=>{
      if(r.error) return rej(new DriveError(r.error_description || 'Google sign-in failed.'));
      gToken = {access_token:r.access_token, exp:Date.now() + r.expires_in*1000};
      prefs.set('gtoken', JSON.stringify(gToken)); res();
    };
    tokenClient.error_callback = e=>rej(new DriveError(e.type==='popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed.'));
    tokenClient.requestAccessToken({prompt:''});
  });
}
async function drive(url, opts={}){
  if(!tokenOk()) throw new DriveError(EXPIRED);
  const r = await fetch(url, {...opts, headers:{Authorization:`Bearer ${gToken.access_token}`, ...opts.headers}});
  if(r.status===401){ gToken=null; prefs.set('gtoken',''); throw new DriveError(EXPIRED); }
  if(!r.ok) throw new DriveError(`Google Drive error ${r.status}.`);
  return r;
}
const qStr = s => `'${s.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'`;
async function driveList(q){
  const out=[]; let page='';
  do{
    const r = await (await drive(`${DRIVE_API}?supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}${page?`&pageToken=${page}`:''}`)).json();
    out.push(...r.files); page = r.nextPageToken || '';
  }while(page);
  return out;
}
// resumable upload: works for any size; with an id it replaces that file's content in place
async function driveUpload(id, name, parent, blob){
  const type = name.endsWith('.txt') ? 'text/plain' : 'image/jpeg';
  const r = await drive(`${UPLOAD_API}${id?`/${id}`:''}?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: id ? 'PATCH' : 'POST',
    headers: {'Content-Type':'application/json; charset=UTF-8', 'X-Upload-Content-Type':type},
    body: JSON.stringify(id ? {} : {name, parents:[parent]})
  });
  const session = r.headers.get('Location');
  if(!session) throw new DriveError('Google Drive upload failed.');
  return (await drive(session, {method:'PUT', headers:{'Content-Type':type}, body:blob})).json();
}
const driveRead = async f => {
  const b = await (await drive(`${DRIVE_API}/${f.id}?alt=media&supportsAllDrives=true`)).blob();
  return new File([b], f.name, {type:b.type, lastModified:Date.parse(f.modifiedTime) || Date.now()});
};
// gallery tiles use Drive's thumbnail, so a phone doesn't download every full photo
async function driveThumb(f){
  if (f.thumbnailLink && tokenOk()){
    try{
      const r = await fetch(f.thumbnailLink.replace(/=s\d+$/,'=s800'), {headers:{Authorization:`Bearer ${gToken.access_token}`}});
      if (r.ok) return await r.blob();
    }catch{}
  }
  return driveRead(f);
}
class DriveFolder {
  constructor(id, name){ this.id=id; this.name=name; }
  async allowed(ask=false){
    if (tokenOk()) return true;
    if (!ask) return false;
    await driveSignIn(); return true;
  }
  async list(){
    return (await driveList(`${qStr(this.id)} in parents and trashed=false`)).map(f=> f.mimeType===FOLDER_MIME
      ? {name:f.name, kind:'dir', folder:new DriveFolder(f.id, f.name)}
      : {name:f.name, kind:'file', read:()=>driveRead(f), thumb:()=>driveThumb(f)});
  }
  async find(name, folder){
    return (await driveList(`${qStr(this.id)} in parents and name=${qStr(name)} and trashed=false and mimeType ${folder?'=':'!='} '${FOLDER_MIME}'`))[0];
  }
  async sub(name, create=false){
    let f = await this.find(name, true);
    if (!f && create) f = await (await drive(`${DRIVE_API}?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, mimeType:FOLDER_MIME, parents:[this.id]})
    })).json();
    if (!f) throw new DriveError(`No folder named ${name}.`);
    return new DriveFolder(f.id, f.name);
  }
  // replaces an existing file's content in place, so its Drive file ID is kept
  async write(name, data){ await driveUpload((await this.find(name, false))?.id, name, this.id, new Blob([data])); }
}
// folders matching a name or a pasted folder link, with their parent's name to tell same-named ones apart
async function findDriveFolders(q){
  const link = q.match(/folders\/([\w-]+)/);
  const found = link
    ? [await (await drive(`${DRIVE_API}/${link[1]}?supportsAllDrives=true&fields=${FILE_FIELDS}`)).json()].filter(f=>f.mimeType===FOLDER_MIME)
    : (await driveList(`mimeType='${FOLDER_MIME}' and name contains ${qStr(q)} and trashed=false`)).slice(0,10);
  return Promise.all(found.map(async f=>({id:f.id, name:f.name, where: f.parents?.[0]
    ? await drive(`${DRIVE_API}/${f.parents[0]}?supportsAllDrives=true&fields=name`).then(r=>r.json()).then(p=>p.name).catch(()=>'')
    : ''})));
}
