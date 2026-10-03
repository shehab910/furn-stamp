// Draws the watermark onto photos. Pure: everything it needs comes in as a plan.
const SLOT_KEYS = ['notes','item','category','store','price','dims'];

/* ---------- watermark layout (fixed slots, same geometry every time) ---------- */
const font = (w,s) => `${w} ${s}px "Segoe UI","Noto Sans Arabic",system-ui,sans-serif`;
const isRTL = t => /[\u0590-\u08FF]/.test(t);
function layout(W,H){
  const base = Math.max(14, Math.round(Math.min(W,H)*0.04));
  const pad = Math.round(base*0.8), inner = W - pad*2;
  const descSize = Math.round(base*0.85), descLH = Math.round(descSize*1.3);
  const topH = pad*2 + descLH*2;
  const itemSize = Math.round(base*1.25), itemLH = Math.round(itemSize*1.3);
  const rowLH = Math.round(base*1.3), gap = Math.round(base*0.35);
  const botH = pad*2 + itemLH + gap + rowLH, y0 = H - botH;
  const colGap = Math.round(base*0.8), usable = inner - colGap*3;
  const star = Math.round(base*1.15), starGap = Math.round(star*0.22), starsW = star*5 + starGap*4;
  const stars = {x:pad+inner-starsW, y:y0+pad, h:itemLH, size:star, gap:starGap};
  const seenW = Math.round(base*4.4), seenH = star;
  const seen = {x:stars.x-colGap-seenW, y:y0+pad+Math.round((itemLH-seenH)/2), w:seenW, h:seenH, size:Math.round(base*0.7)};
  const slots = {
    notes:{x:pad, y:pad, w:inner, size:descSize, weight:400, lines:2, lh:descLH},
    item:{x:pad, y:y0+pad, w:seen.x-colGap-pad, h:itemLH, size:itemSize, weight:700}
  };
  let x = pad;
  [['category',.2],['store',.32],['price',.22],['dims',.26]].forEach(([k,fr])=>{
    const w = Math.floor(usable*fr);
    slots[k] = {x, y:y0+pad+itemLH+gap, w, h:rowLH, size:base, weight:500};
    x += w + colGap;
  });
  return {base, topH, botH, y0, colGap, slots, stars, seen};
}
function drawBands(ctx, L, W){
  ctx.fillStyle='rgba(0,0,0,.6)';
  ctx.fillRect(0,0,W,L.topH);
  ctx.fillRect(0,L.y0,W,L.botH);
  ctx.fillStyle='rgba(255,255,255,.22)';
  ['store','price','dims'].forEach(k=>{
    const s=L.slots[k];
    ctx.fillRect(Math.round(s.x - L.colGap/2), s.y+2, Math.max(1,Math.round(L.base/14)), s.h-4);
  });
}
function ellipsize(ctx, t, maxW, force=false){
  if (!force && ctx.measureText(t).width<=maxW) return t;
  while (t.length>1 && ctx.measureText(t+'…').width>maxW) t=t.slice(0,-1);
  return t.trimEnd()+'…';
}
function wrap(ctx, text, maxW){
  const out=[];
  text.split('\n').forEach(par=>{
    let line='';
    par.split(/\s+/).forEach(w=>{
      const t = line ? line+' '+w : w;
      if (ctx.measureText(t).width>maxW && line){ out.push(line); line=w; } else line=t;
    });
    if (line) out.push(line);
  });
  return out;
}
function drawSlot(ctx, s, text){
  if (!text) return;
  const rtl = isRTL(text);
  ctx.direction = rtl?'rtl':'ltr'; ctx.textAlign = rtl?'right':'left'; ctx.textBaseline='middle';
  ctx.fillStyle='#fff';
  const x = rtl ? s.x+s.w : s.x;
  if (s.lines){
    ctx.font = font(s.weight, s.size);
    let ls = wrap(ctx, text, s.w);
    if (ls.length > s.lines){ ls = ls.slice(0,s.lines); ls[s.lines-1] = ellipsize(ctx, ls[s.lines-1], s.w, true); }
    ls.forEach((t,k)=>ctx.fillText(ellipsize(ctx,t,s.w), x, s.y + s.lh*k + s.lh/2));
  } else {
    let size = s.size; ctx.font = font(s.weight,size);
    while (ctx.measureText(text).width > s.w && size > s.size*0.7){ size--; ctx.font = font(s.weight,size); }
    ctx.fillText(ellipsize(ctx,text,s.w), x, s.y + s.h/2);
  }
  ctx.direction='ltr'; ctx.textAlign='left';
}
function drawStars(ctx, S, rating){
  const r = S.size/2, ri = r*0.45, cy = S.y + S.h/2;
  for (let k=0;k<5;k++){
    const cx = S.x + k*(S.size+S.gap) + r, on = k < rating;
    ctx.beginPath();
    for (let j=0;j<10;j++){
      const a = -Math.PI/2 + j*Math.PI/5, rad = j%2 ? ri : r;
      ctx[j?'lineTo':'moveTo'](cx + rad*Math.cos(a), cy + rad*Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = on ? '#E8B931' : '#0d0d0d'; ctx.fill();
    ctx.lineWidth = Math.max(1, S.size/16); ctx.lineJoin='round';
    ctx.strokeStyle = on ? '#E8B931' : '#6e6e6e'; ctx.stroke();
  }
}
// opaque pill left of the stars; both states cover the same pixels, so toggling overlays cleanly
function drawSeen(ctx, S, on){
  const r = S.h/2;
  ctx.beginPath(); ctx.roundRect(S.x, S.y, S.w, S.h, r);
  ctx.fillStyle = on ? '#2F7A52' : '#0d0d0d'; ctx.fill();
  ctx.lineWidth = Math.max(1, S.h/16); ctx.strokeStyle = on ? '#2F7A52' : '#6e6e6e'; ctx.stroke();
  let size = S.size; const t = on ? '✓ Seen IRL' : 'Not seen';
  ctx.font = font(700,size);
  while (ctx.measureText(t).width > S.w - r*1.2 && size > 6){ size--; ctx.font = font(700,size); }
  ctx.fillStyle = on ? '#fff' : '#9a9a9a'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(t, S.x + S.w/2, S.y + S.h/2);
  ctx.textAlign='left';
}

// plan = {full, slots:{key:text}, rating, seen}. A full plan draws the bands and every slot; otherwise only
// the given slots are overlaid, with no backdrop. Rating and seen IRL are always drawn and are opaque, so
// they cover the old ones. The image is scaled before stamping, so slot geometry can be recomputed exactly
// from the saved file's dimensions when editing later.
function paint(bmp, plan, canvas, maxEdge=Infinity){
  const sc = Math.min(1, maxEdge/Math.max(bmp.width,bmp.height));
  const W=Math.round(bmp.width*sc), H=Math.round(bmp.height*sc);
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(bmp,0,0,W,H);
  const L=layout(W,H);
  if (plan.full) drawBands(ctx, L, W);
  Object.entries(plan.slots).forEach(([k,t])=>drawSlot(ctx, L.slots[k], t));
  drawStars(ctx, L.stars, plan.rating);
  drawSeen(ctx, L.seen, plan.seen);
  return canvas;
}
const loadBmp = f => createImageBitmap(f, {imageOrientation:'from-image'});
async function renderPlan(file, plan, canvas){
  const bmp=await loadBmp(file);
  try{ return paint(bmp,plan,canvas); } finally{ bmp.close?.(); }
}

/* ---------- encoding ---------- */
const MAX_BYTES = 10*1024*1024;
const encode = (c,q) => new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('Could not encode image')),'image/jpeg',q));
async function stampedJpeg(file, plan, canvas){   // new photos: high quality, capped at 10 MB
  const bmp=await loadBmp(file);
  try{
    let blob, last=0;
    for (const edge of [Infinity,6000,4096,3200]){
      const size=Math.min(edge, Math.max(bmp.width,bmp.height));
      if (size===last) continue; last=size;
      paint(bmp,plan,canvas,edge);
      for (const q of [0.95,0.92,0.88,0.82]){
        blob=await encode(canvas,q);
        if (blob.size<=MAX_BYTES) return blob;
      }
    }
    return blob;
  } finally{ bmp.close?.(); }
}
// saved photos: overlay at full size, no cap
const overlayJpeg = async (file, plan, canvas) => encode(await renderPlan(file, plan, canvas), 0.95);
