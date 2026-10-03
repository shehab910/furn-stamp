// How pieces are named: category_YYYY-MM-DD_xxxx_NN.jpg photos inside a per-category folder.

export const PHOTO_RE = /^(.+)_(\d+)\.jpe?g$/i;

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// a random 4-character id that groups one save's photos
export const newBatchId = (): string => Math.random().toString(36).slice(2, 6).padEnd(4, '0');

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// the category as typed, minus characters Windows forbids in folder names
export function categoryFolderName(category: string): string {
  return category.normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 60) || 'Other';
}

export const pieceBase = (category: string, batchId: string): string =>
  [slug(category) || 'category', today(), batchId].join('_');

// photo `index` (0-based) of `total`; numbers are zero-padded to at least 2 digits
export function photoName(base: string, index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${base}_${String(index + 1).padStart(width, '0')}.jpg`;
}
