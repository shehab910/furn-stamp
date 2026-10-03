// Save folder on desktop Chrome/Edge: a local folder (synced by Google Drive for desktop),
// through the File System Access API.
import type { Entry, Folder } from './pieces';

export class LocalFolder implements Folder {
  readonly name: string;
  constructor(readonly handle: FileSystemDirectoryHandle) { this.name = handle.name; }

  async allowed(ask = false): Promise<boolean> {
    if (await this.handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return ask && await this.handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  }
  async list(): Promise<Entry[]> {
    const out: Entry[] = [];
    for await (const [name, h] of this.handle.entries())
      out.push(h.kind === 'directory'
        ? { name, kind: 'dir', folder: new LocalFolder(h) }
        : { name, kind: 'file', read: () => h.getFile() });
    return out;
  }
  async sub(name: string, create = false): Promise<LocalFolder> {
    return new LocalFolder(await this.handle.getDirectoryHandle(name, { create }));
  }
  async write(name: string, data: Blob | string): Promise<void> {
    const fh = await this.handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  // the folder and name of a file picked from inside this folder, or null
  async locate(file: FileSystemFileHandle): Promise<{ folder: LocalFolder; name: string } | null> {
    const path = await this.handle.resolve(file);
    if (!path) return null;
    let folder: LocalFolder = this;
    for (const part of path.slice(0, -1)) folder = await folder.sub(part);
    return { folder, name: path[path.length - 1] };
  }
}
