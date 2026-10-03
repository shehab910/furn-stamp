// Save folder on phones: the same synced folder, reached through the Google Drive REST API,
// since mobile browsers can't open local folders.
import { prefs, readJson } from '../prefs';
import type { Entry, Folder } from './pieces';

const GOOGLE_CLIENT_ID = '';   // OAuth web client ID from Google Cloud; only phones need it
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,thumbnailLink,parents';
const EXPIRED = 'Google Drive sign-in expired. Tap again to reconnect.';

type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; thumbnailLink?: string; parents?: string[] };
type Token = { access_token: string; exp: number };

// Drive failures carry a message meant for the user.
export class DriveError extends Error {
  constructor(message: string) { super(message); this.name = 'DriveError'; }
}

/* ---------- sign-in (Google Identity Services; the 1-hour token is kept in localStorage) ---------- */
function storedToken(): Token | null {
  const t = readJson('gtoken');
  return t && typeof t === 'object' && 'access_token' in t && 'exp' in t
    && typeof t.access_token === 'string' && typeof t.exp === 'number' ? { access_token: t.access_token, exp: t.exp } : null;
}
let token = storedToken();
let tokenClient: google.accounts.oauth2.TokenClient | null = null;
// the sign-in in progress; the token client reports back to whichever call started last
let pending: { resolve: () => void; reject: (e: DriveError) => void } | null = null;

export const signedIn = (): boolean => !!token && Date.now() < token.exp - 60000;

// loads the Google sign-in script; call once at startup on phones
export function loadSignInScript(): void {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  document.head.appendChild(s);
}

export function signIn(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_CLIENT_ID) return reject(new DriveError('Google sign-in isn’t set up yet: GOOGLE_CLIENT_ID is empty.'));
    if (typeof google === 'undefined' || !google.accounts?.oauth2) return reject(new DriveError('Google sign-in is still loading. Try again in a moment.'));
    pending = { resolve, reject };
    tokenClient ??= google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive',
      callback: r => {
        if (r.error) return pending?.reject(new DriveError(r.error_description || 'Google sign-in failed.'));
        token = { access_token: r.access_token, exp: Date.now() + Number(r.expires_in) * 1000 };
        prefs.set('gtoken', JSON.stringify(token));
        pending?.resolve();
      },
      error_callback: e => pending?.reject(new DriveError(e.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed.')),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

/* ---------- REST calls ---------- */
async function drive(url: string, opts: RequestInit = {}): Promise<Response> {
  if (!token || !signedIn()) throw new DriveError(EXPIRED);
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token.access_token}`, ...opts.headers } });
  if (r.status === 401) { token = null; prefs.set('gtoken', ''); throw new DriveError(EXPIRED); }
  if (!r.ok) throw new DriveError(`Google Drive error ${r.status}.`);
  return r;
}
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function driveList(q: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let page = '';
  do {
    const fields = encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`);
    const r = await json<{ files: DriveFile[]; nextPageToken?: string }>(drive(
      `${DRIVE_API}?supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000&q=${encodeURIComponent(q)}&fields=${fields}${page ? `&pageToken=${page}` : ''}`));
    out.push(...r.files);
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

// resumable upload: works for any size; with an id it replaces that file's content in place
async function driveUpload(id: string | undefined, name: string, parent: string, blob: Blob): Promise<void> {
  const type = name.endsWith('.txt') ? 'text/plain' : 'image/jpeg';
  const r = await drive(`${UPLOAD_API}${id ? `/${id}` : ''}?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
    body: JSON.stringify(id ? {} : { name, parents: [parent] }),
  });
  const session = r.headers.get('Location');
  if (!session) throw new DriveError('Google Drive upload failed.');
  await (await drive(session, { method: 'PUT', headers: { 'Content-Type': type }, body: blob })).json();
}

async function driveRead(f: DriveFile): Promise<File> {
  const b = await (await drive(`${DRIVE_API}/${f.id}?alt=media&supportsAllDrives=true`)).blob();
  return new File([b], f.name, { type: b.type, lastModified: Date.parse(f.modifiedTime ?? '') || Date.now() });
}

// gallery tiles use Drive's thumbnail, so a phone doesn't download every full photo
async function driveThumb(f: DriveFile): Promise<Blob> {
  if (f.thumbnailLink && token && signedIn()) {
    try {
      const r = await fetch(f.thumbnailLink.replace(/=s\d+$/, '=s800'), { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (r.ok) return await r.blob();
    } catch { /* fall back to the full photo */ }
  }
  return driveRead(f);
}

export class DriveFolder implements Folder {
  constructor(readonly id: string, readonly name: string) {}

  async allowed(ask = false): Promise<boolean> {
    if (signedIn()) return true;
    if (!ask) return false;
    await signIn();
    return true;
  }
  async list(): Promise<Entry[]> {
    return (await driveList(`${quote(this.id)} in parents and trashed=false`)).map((f): Entry => f.mimeType === FOLDER_MIME
      ? { name: f.name, kind: 'dir', folder: new DriveFolder(f.id, f.name) }
      : { name: f.name, kind: 'file', read: () => driveRead(f), thumb: () => driveThumb(f) });
  }
  private async find(name: string, folder: boolean): Promise<DriveFile | undefined> {
    return (await driveList(`${quote(this.id)} in parents and name=${quote(name)} and trashed=false and mimeType ${folder ? '=' : '!='} '${FOLDER_MIME}'`))[0];
  }
  async sub(name: string, create = false): Promise<DriveFolder> {
    let f = await this.find(name, true);
    if (!f && create) f = await json<DriveFile>(drive(`${DRIVE_API}?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [this.id] }),
    }));
    if (!f) throw new DriveError(`No folder named ${name}.`);
    return new DriveFolder(f.id, f.name);
  }
  // replaces an existing file's content in place, so its Drive file ID is kept
  async write(name: string, data: Blob | string): Promise<void> {
    await driveUpload((await this.find(name, false))?.id, name, this.id, new Blob([data]));
  }
}

export type FolderMatch = { id: string; name: string; where: string };

// folders matching a name or a pasted folder link, with their parent's name to tell same-named ones apart
export async function findDriveFolders(q: string): Promise<FolderMatch[]> {
  const link = q.match(/folders\/([\w-]+)/);
  const found = link
    ? [await json<DriveFile>(drive(`${DRIVE_API}/${link[1]}?supportsAllDrives=true&fields=${FILE_FIELDS}`))].filter(f => f.mimeType === FOLDER_MIME)
    : (await driveList(`mimeType='${FOLDER_MIME}' and name contains ${quote(q)} and trashed=false`)).slice(0, 10);
  return Promise.all(found.map(async f => {
    const parent = f.parents?.[0];
    const where = parent
      ? await json<{ name: string }>(drive(`${DRIVE_API}/${parent}?supportsAllDrives=true&fields=name`)).then(p => p.name).catch(() => '')
      : '';
    return { id: f.id, name: f.name, where };
  }));
}
