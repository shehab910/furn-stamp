// The piece store: how pieces are found and loaded, on either kind of save folder.
// A piece is a category subfolder holding base_NN.jpg photos plus a base.txt sidecar.
import { categoryFolderName, PHOTO_RE } from './naming';
import { emptyInfo, parseInfo, type PieceInfo } from './sidecar';

export type FileEntry = {
  kind: 'file';
  name: string;
  read(): Promise<File>;
  thumb?(): Promise<Blob>;   // a smaller preview, when the folder can give one cheaply
};
export type Entry = FileEntry | { kind: 'dir'; name: string; folder: Folder };

// What both save folders (local and Google Drive) offer.
export interface Folder {
  readonly name: string;
  // whether we may read and write; with `ask`, prompt the user for it
  allowed(ask?: boolean): Promise<boolean>;
  list(): Promise<Entry[]>;
  sub(name: string, create?: boolean): Promise<Folder>;
  write(name: string, data: Blob | string): Promise<void>;
}

export type Piece = { folder: Folder; base: string; info: PieceInfo; photos: FileEntry[] };

export const categoryFolder = (root: Folder, category: string): Promise<Folder> =>
  root.sub(categoryFolderName(category), true);

const readInfo = async (e: FileEntry): Promise<PieceInfo | null> => parseInfo(await (await e.read()).text());

// every piece under root (category subfolders, plus older Category/piece/info.txt ones)
export async function listPieces(root: Folder): Promise<Piece[]> {
  const out: Piece[] = [];
  async function walk(folder: Folder, depth: number): Promise<void> {
    const groups = new Map<string, FileEntry[]>(), txts = new Map<string, FileEntry>();
    for (const e of await folder.list()) {
      if (e.kind === 'dir') { if (depth < 2) await walk(e.folder, depth + 1); continue; }
      const m = e.name.match(PHOTO_RE);
      if (m) groups.set(m[1], [...(groups.get(m[1]) ?? []), e]);
      else if (e.name.endsWith('.txt')) txts.set(e.name, e);
    }
    await Promise.all([...groups].map(async ([base, photos]) => {
      const txt = txts.get(`${base}.txt`) ?? (groups.size === 1 ? txts.get('info.txt') : undefined);
      if (!txt) return;
      photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      out.push({ folder, base, info: (await readInfo(txt)) ?? emptyInfo(), photos });
    }));
  }
  await walk(root, 0);
  return out;
}

export type PiecePhoto = { name: string; num: number; file: File };

// one piece's sidecar and its photos, in number order
export async function loadPiece(folder: Folder, base: string): Promise<{ info: PieceInfo | null; infoName: string | null; photos: PiecePhoto[] }> {
  let info: PieceInfo | null = null, infoName: string | null = null;
  const photos: PiecePhoto[] = [];
  for (const e of await folder.list()) {
    if (e.kind !== 'file') continue;
    if (e.name === `${base}.txt` || (e.name === 'info.txt' && !infoName)) { info = await readInfo(e); infoName = e.name; continue; }
    const m = e.name.match(PHOTO_RE);
    if (m && m[1].toLowerCase() === base.toLowerCase()) photos.push({ name: e.name, num: +m[2], file: await e.read() });
  }
  photos.sort((a, b) => a.num - b.num);
  return { info, infoName, photos };
}
