// A piece's info, and its .txt sidecar format: one "Label: value" line each, Description last
// because it can span several lines.

export const TEXT_FIELDS = ['category', 'item', 'store', 'price', 'size', 'description'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export type PieceInfo = Record<TextField, string> & {
  layout: string | null;   // as read from the file; null when absent (new pieces get LAYOUT)
  rating: number;          // 0 (unrated) to 5
  seen: boolean;
  date: string;
};

export const LAYOUT = '4';                  // 4: narrower item slot to fit the seen IRL badge
const EDITABLE_LAYOUTS = ['3', LAYOUT];     // 3 pieces get the badge over the end of their item row

export const isEditable = (info: PieceInfo): boolean => info.layout !== null && EDITABLE_LAYOUTS.includes(info.layout);

export const clampRating = (text: string): number => Math.max(0, Math.min(5, parseInt(text, 10) || 0));

export const emptyInfo = (): PieceInfo => ({
  layout: null, category: '', item: '', store: '', price: '', size: '', description: '', rating: 0, seen: false, date: '',
});

type Key = keyof PieceInfo;
const LABELS: [Key, string][] = [
  ['layout', 'Layout'], ['category', 'Category'], ['item', 'Item'], ['store', 'Store'], ['price', 'Price'],
  ['size', 'Size'], ['rating', 'Rating'], ['seen', 'Seen'], ['date', 'Date'], ['description', 'Description'],
];
// older sidecars called the description "Notes"
const KEY_BY_LABEL = new Map<string, Key>([...LABELS.map(([k, l]): [string, Key] => [l, k]), ['Notes', 'description']]);

export function formatInfo(info: PieceInfo): string {
  const value = (k: Key): string => {
    switch (k) {
      case 'layout': return info.layout || LAYOUT;
      case 'rating': return String(info.rating);
      case 'seen': return info.seen ? 'yes' : 'no';
      default: return info[k];
    }
  };
  return LABELS.map(([k, label]) => { const v = value(k); return v ? `${label}: ${v}` : ''; })
    .filter(Boolean).join('\n') + '\n';
}

// null when the text holds no known label at all
export function parseInfo(text: string): PieceInfo | null {
  const raw = new Map<Key, string>();
  let inDescription = false;
  for (const line of text.split(/\r?\n/)) {
    const m: RegExpMatchArray | null = inDescription ? null : line.match(/^(\w+):\s*(.*)$/);
    const key: Key | undefined = m ? KEY_BY_LABEL.get(m[1]) : undefined;
    if (m && key) { raw.set(key, m[2]); inDescription = key === 'description'; }
    else if (inDescription) raw.set('description', raw.get('description') + '\n' + line);
  }
  if (!raw.size) return null;
  const info = emptyInfo();
  for (const k of TEXT_FIELDS) info[k] = raw.get(k) ?? '';
  info.description = info.description.trim();
  info.date = raw.get('date') ?? '';
  info.layout = raw.get('layout') ?? null;
  info.rating = clampRating(raw.get('rating') ?? '');
  info.seen = raw.get('seen') === 'yes';
  return info;
}
