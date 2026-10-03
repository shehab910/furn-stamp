// Draws the watermark onto photos. Pure: everything it needs comes in as a plan.

// the text slots, in the order they're drawn
export const SLOT_KEYS = ['description', 'item', 'category', 'store', 'price', 'size'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

// What to draw. A full plan draws the bands and every slot; otherwise only the given slots are
// overlaid, with no backdrop. Rating and seen IRL are always drawn and are opaque, so they cover
// the old ones.
export type Plan = { full: boolean; slots: Partial<Record<SlotKey, string>>; rating: number; seen: boolean };

/* ---------- watermark layout (fixed slots, same geometry every time) ---------- */
// h is the slot's full height; lh the height of each of its `lines` lines
type Slot = { x: number; y: number; w: number; h: number; size: number; weight: number; lines: number; lh: number };
type StarsBox = { x: number; y: number; h: number; size: number; gap: number };
type SeenBox = { x: number; y: number; w: number; h: number; size: number };
export type Layout = { base: number; topH: number; botH: number; y0: number; colGap: number; slots: Record<SlotKey, Slot>; stars: StarsBox; seen: SeenBox };

const font = (weight: number, size: number): string => `${weight} ${size}px "Segoe UI","Noto Sans Arabic",system-ui,sans-serif`;
const isRTL = (t: string): boolean => /[֐-ࣿ]/.test(t);

// All sizes are relative to min(W,H)*0.04, so the geometry can be recomputed from a saved file's size.
export function layout(W: number, H: number): Layout {
  const base = Math.max(14, Math.round(Math.min(W, H) * 0.04));
  const pad = Math.round(base * 0.8), inner = W - pad * 2;
  const descSize = Math.round(base * 0.85), descLH = Math.round(descSize * 1.3);
  const topH = pad * 2 + descLH * 2;
  const itemSize = Math.round(base * 1.25), itemLH = Math.round(itemSize * 1.3);
  const rowLH = Math.round(base * 1.3), gap = Math.round(base * 0.35);
  const botH = pad * 2 + itemLH + gap + rowLH, y0 = H - botH;
  const colGap = Math.round(base * 0.8), usable = inner - colGap * 3;
  const star = Math.round(base * 1.15), starGap = Math.round(star * 0.22), starsW = star * 5 + starGap * 4;
  const stars = { x: pad + inner - starsW, y: y0 + pad, h: itemLH, size: star, gap: starGap };
  const seenW = Math.round(base * 4.4), seenH = star;
  const seen = { x: stars.x - colGap - seenW, y: y0 + pad + Math.round((itemLH - seenH) / 2), w: seenW, h: seenH, size: Math.round(base * 0.7) };

  // bottom row 2: fixed-width columns
  const row2: Partial<Record<SlotKey, Slot>> = {};
  let x = pad;
  for (const [k, share] of [['category', .2], ['store', .32], ['price', .22], ['size', .26]] as const) {
    const w = Math.floor(usable * share);
    row2[k] = { x, y: y0 + pad + itemLH + gap, w, h: rowLH, size: base, weight: 500, lines: 1, lh: rowLH };
    x += w + colGap;
  }
  const slots = {
    description: { x: pad, y: pad, w: inner, h: descLH * 2, size: descSize, weight: 400, lines: 2, lh: descLH },
    item: { x: pad, y: y0 + pad, w: seen.x - colGap - pad, h: itemLH, size: itemSize, weight: 700, lines: 1, lh: itemLH },
    ...row2,
  } as Record<SlotKey, Slot>;
  return { base, topH, botH, y0, colGap, slots, stars, seen };
}

function drawBands(ctx: CanvasRenderingContext2D, L: Layout, W: number): void {
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(0, 0, W, L.topH);
  ctx.fillRect(0, L.y0, W, L.botH);
  ctx.fillStyle = 'rgba(255,255,255,.22)';
  for (const k of ['store', 'price', 'size'] as const) {   // column dividers
    const s = L.slots[k];
    ctx.fillRect(Math.round(s.x - L.colGap / 2), s.y + 2, Math.max(1, Math.round(L.base / 14)), s.h - 4);
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, t: string, maxW: number, force = false): string {
  if (!force && ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const par of text.split('\n')) {
    let line = '';
    for (const word of par.split(/\s+/)) {
      const t = line ? line + ' ' + word : word;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    if (line) out.push(line);
  }
  return out;
}

function drawSlot(ctx: CanvasRenderingContext2D, s: Slot, text: string | undefined): void {
  if (!text) return;
  const rtl = isRTL(text);
  ctx.direction = rtl ? 'rtl' : 'ltr'; ctx.textAlign = rtl ? 'right' : 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  const x = rtl ? s.x + s.w : s.x;
  if (s.lines > 1) {
    // multi-line: wrap, keep `lines` lines, cut the last with "…"
    const lh = s.lh;
    ctx.font = font(s.weight, s.size);
    let lines = wrap(ctx, text, s.w);
    if (lines.length > s.lines) { lines = lines.slice(0, s.lines); lines[s.lines - 1] = ellipsize(ctx, lines[s.lines - 1], s.w, true); }
    lines.forEach((t, k) => ctx.fillText(ellipsize(ctx, t, s.w), x, s.y + lh * k + lh / 2));
  } else {
    // single line: shrink to 70%, then cut with "…"
    let size = s.size;
    ctx.font = font(s.weight, size);
    while (ctx.measureText(text).width > s.w && size > s.size * 0.7) { size--; ctx.font = font(s.weight, size); }
    ctx.fillText(ellipsize(ctx, text, s.w), x, s.y + s.h / 2);
  }
  ctx.direction = 'ltr'; ctx.textAlign = 'left';
}

function drawStars(ctx: CanvasRenderingContext2D, S: StarsBox, rating: number): void {
  const r = S.size / 2, ri = r * 0.45, cy = S.y + S.h / 2;
  for (let k = 0; k < 5; k++) {
    const cx = S.x + k * (S.size + S.gap) + r, on = k < rating;
    ctx.beginPath();
    for (let j = 0; j < 10; j++) {
      const a = -Math.PI / 2 + j * Math.PI / 5, rad = j % 2 ? ri : r;
      const px = cx + rad * Math.cos(a), py = cy + rad * Math.sin(a);
      if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = on ? '#E8B931' : '#0d0d0d'; ctx.fill();
    ctx.lineWidth = Math.max(1, S.size / 16); ctx.lineJoin = 'round';
    ctx.strokeStyle = on ? '#E8B931' : '#6e6e6e'; ctx.stroke();
  }
}

// opaque pill left of the stars; both states cover the same pixels, so toggling overlays cleanly
function drawSeen(ctx: CanvasRenderingContext2D, S: SeenBox, on: boolean): void {
  const r = S.h / 2;
  ctx.beginPath(); ctx.roundRect(S.x, S.y, S.w, S.h, r);
  ctx.fillStyle = on ? '#2F7A52' : '#0d0d0d'; ctx.fill();
  ctx.lineWidth = Math.max(1, S.h / 16); ctx.strokeStyle = on ? '#2F7A52' : '#6e6e6e'; ctx.stroke();
  const t = on ? '✓ Seen IRL' : 'Not seen';
  let size = S.size;
  ctx.font = font(700, size);
  while (ctx.measureText(t).width > S.w - r * 1.2 && size > 6) { size--; ctx.font = font(700, size); }
  ctx.fillStyle = on ? '#fff' : '#9a9a9a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t, S.x + S.w / 2, S.y + S.h / 2);
  ctx.textAlign = 'left';
}

// Draws the photo, scaled down to maxEdge, then the stamp. Scaling happens first, so slot geometry
// can be recomputed exactly from the saved file's dimensions when editing later.
function paint(bmp: ImageBitmap, plan: Plan, canvas: HTMLCanvasElement, maxEdge = Infinity): HTMLCanvasElement {
  const sc = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * sc), H = Math.round(bmp.height * sc);
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, W, H);
  const L = layout(W, H);
  if (plan.full) drawBands(ctx, L, W);
  for (const [k, t] of Object.entries(plan.slots) as [SlotKey, string][]) drawSlot(ctx, L.slots[k], t);
  drawStars(ctx, L.stars, plan.rating);
  drawSeen(ctx, L.seen, plan.seen);
  return canvas;
}

const loadBitmap = (f: Blob): Promise<ImageBitmap> => createImageBitmap(f, { imageOrientation: 'from-image' });

export async function renderPlan(file: Blob, plan: Plan, canvas: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const bmp = await loadBitmap(file);
  try { return paint(bmp, plan, canvas); } finally { bmp.close(); }
}

/* ---------- encoding ---------- */
const MAX_BYTES = 10 * 1024 * 1024;
const encode = (c: HTMLCanvasElement, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode image')), 'image/jpeg', quality));

// new photos: full resolution, capped at 10 MB by stepping quality down first, then resolution
export async function stampedJpeg(file: Blob, plan: Plan, canvas: HTMLCanvasElement): Promise<Blob> {
  const bmp = await loadBitmap(file);
  try {
    let blob: Blob | undefined, last = 0;
    for (const edge of [Infinity, 6000, 4096, 3200]) {
      const size = Math.min(edge, Math.max(bmp.width, bmp.height));
      if (size === last) continue;
      last = size;
      paint(bmp, plan, canvas, edge);
      for (const q of [0.95, 0.92, 0.88, 0.82]) {
        blob = await encode(canvas, q);
        if (blob.size <= MAX_BYTES) return blob;
      }
    }
    if (!blob) throw new Error('Could not encode image');
    return blob;
  } finally { bmp.close(); }
}

// saved photos: overlay at full size, no cap
export const overlayJpeg = async (file: Blob, plan: Plan, canvas: HTMLCanvasElement): Promise<Blob> =>
  encode(await renderPlan(file, plan, canvas), 0.95);
