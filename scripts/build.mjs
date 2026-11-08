// Builds dist/ from src/, brand/ and register.json. No bundler, no network.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderCaSlot, renderSocials, renderChips } from '../src/js/register-view.js';

const root = path.resolve(import.meta.dirname, '..');
const src = (...p) => path.join(root, 'src', ...p);
const dist = (...p) => path.join(root, 'dist', ...p);
const LOGO_ALPHA = path.join(root, 'brand', 'LOGO CYCLE PNG...png'); // the only brand file with an alpha channel (IHDR colour type 6)

fs.rmSync(dist(), { recursive: true, force: true });
for (const d of ['css', 'js', 'fonts', 'assets']) fs.mkdirSync(dist(d), { recursive: true });

/* ---------- tokens ---------- */
const tokensCss = fs.readFileSync(src('tokens.css'), 'utf8');
const tokens = {};
for (const m of tokensCss.matchAll(/--(color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  const h = m[2].toLowerCase();
  tokens[m[1]] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), h];
}

/* ---------- register, prerender ---------- */
const register = JSON.parse(fs.readFileSync(src('register.json'), 'utf8'));
const shipped = JSON.parse(JSON.stringify(register));
for (const rec of Object.values(shipped.records)) delete rec.checked; // dates stay in src/register.json only
delete shipped.note;
fs.writeFileSync(dist('register.json'), JSON.stringify(shipped, null, 2) + '\n');

let html = fs.readFileSync(src('index.html'), 'utf8');
html = html
  .replace('<!--CA_SLOT-->', renderCaSlot(register.records.ca))
  .replace('<!--SOCIALS-->', renderSocials(register))
  .replace('<!--CHIPS-->', renderChips(register));
fs.writeFileSync(dist('index.html'), html);

/* ---------- static copies ---------- */
fs.copyFileSync(src('tokens.css'), dist('css', 'tokens.css'));
fs.copyFileSync(src('styles.css'), dist('css', 'styles.css'));
for (const f of fs.readdirSync(src('js'))) fs.copyFileSync(src('js', f), dist('js', f));
for (const f of fs.readdirSync(src('fonts'))) fs.copyFileSync(src('fonts', f), dist('fonts', f));
fs.writeFileSync(dist('_headers'), [
  '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', '',
  '/register.json', '  Cache-Control: no-cache', '',
  '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', '',
  '/fonts/*', '  Cache-Control: public, max-age=31536000, immutable', ''
].join('\n'));
fs.writeFileSync(dist('robots.txt'), 'User-agent: *\nAllow: /\n');

/* ---------- logo: premultiplied resize ---------- */
// The alpha PNG has millions of pure-black pixels at alpha 0. A straight-alpha resize would drag that
// black into every edge pixel. Every resample here weights colour by alpha (premultiplied) and
// un-premultiplies afterwards.
function boxResize(buf, w, h, ow, oh) {
  const out = Buffer.alloc(ow * oh * 4);
  const sx = w / ow, sy = h / oh;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * sy, y1 = y0 + sy;
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, aw = 0, tw = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wt = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * wy;
          const i = (yy * w + xx) * 4;
          const a = buf[i + 3] / 255;
          r += buf[i] * a * wt; g += buf[i + 1] * a * wt; b += buf[i + 2] * a * wt;
          aw += a * wt; tw += wt;
        }
      }
      const o = (oy * ow + ox) * 4;
      out[o + 3] = Math.round((aw / tw) * 255);
      if (aw > 0) { out[o] = Math.round(r / aw); out[o + 1] = Math.round(g / aw); out[o + 2] = Math.round(b / aw); }
    }
  }
  return out;
}

const full = await sharp(LOGO_ALPHA).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = full.info.width, H = full.info.height;
let x0 = W, y0 = H, x1 = 0, y1 = 0;
for (let i = 0; i < W * H; i++) {
  if (full.data[i * 4 + 3] > 8) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
}
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
function squareCrop(side) {
  const sx = Math.round(cx - side / 2), sy = Math.round(cy - side / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const X = sx + x, Y = sy + y;
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    full.data.copy(out, (y * side + x) * 4, (Y * W + X) * 4, (Y * W + X) * 4 + 4);
  }
  return out;
}
const pad = Math.ceil(Math.max(bw, bh) * 1.1);
const padded = squareCrop(pad);
const png = (buf, s) => sharp(buf, { raw: { width: s, height: s, channels: 4 } }).png({ compressionLevel: 9 });
await png(boxResize(padded, pad, pad, 512, 512), 512).toFile(dist('assets', 'cycle-logo.png'));
await png(boxResize(padded, pad, pad, 192, 192), 192).toFile(dist('assets', 'logo-192.png'));

/* ---------- favicon: traced from the real pixel grid ---------- */
const tight = Math.max(bw, bh);
const fav = squareCrop(tight);
const grid = boxResize(fav, tight, tight, 32, 32);
const palette = ['color-bg-deep', 'color-surface', 'color-surface-2', 'color-line', 'color-blue', 'color-ice-soft', 'color-ice', 'color-ice-hi', 'color-mint'].map((k) => tokens[k]);
const byColour = new Map();
for (let y = 0; y < 32; y++) {
  let x = 0;
  while (x < 32) {
    const i = (y * 32 + x) * 4;
    if (grid[i + 3] < 128) { x++; continue; }
    let best = palette[0], bd = Infinity;
    for (const p of palette) { const d = (p[0] - grid[i]) ** 2 + (p[1] - grid[i + 1]) ** 2 + (p[2] - grid[i + 2]) ** 2; if (d < bd) { bd = d; best = p; } }
    let run = 1;
    while (x + run < 32) {
      const j = (y * 32 + x + run) * 4;
      if (grid[j + 3] < 128) break;
      let b2 = palette[0], bd2 = Infinity;
      for (const p of palette) { const d = (p[0] - grid[j]) ** 2 + (p[1] - grid[j + 1]) ** 2 + (p[2] - grid[j + 2]) ** 2; if (d < bd2) { bd2 = d; b2 = p; } }
      if (b2 !== best) break;
      run++;
    }
    if (!byColour.has(best[3])) byColour.set(best[3], []);
    byColour.get(best[3]).push(`<rect x="${x}" y="${y}" width="${run}" height="1"/>`);
    x += run;
  }
}
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">';
for (const [hex, rects] of byColour) svg += `<g fill="${hex}">${rects.join('')}</g>`;
svg += '</svg>\n';
fs.writeFileSync(dist('favicon.svg'), svg);

/* ---------- share image ---------- */
const bg = tokens['color-bg'];
await sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: bg[0], g: bg[1], b: bg[2] } } })
  .composite([{ input: await sharp(dist('assets', 'cycle-logo.png')).resize(460, 460).toBuffer(), gravity: 'centre' }])
  .png({ compressionLevel: 9 }).toFile(dist('assets', 'og.png'));

console.log(`[build] dist/ ready. logo bbox ${x0},${y0}-${x1},${y1} (${bw}x${bh}); favicon runs: ${[...byColour.values()].reduce((s, a) => s + a.length, 0)}`);
