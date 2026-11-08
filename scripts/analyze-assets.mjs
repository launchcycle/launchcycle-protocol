// Reads every file in brand/ and reference/: container header, alpha histogram, k-means palette.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const root = path.resolve(import.meta.dirname, '..');
const out = {};
function ihdr(buf) {
  if (buf.slice(1, 4).toString() !== 'PNG') return null;
  const ct = buf[25];
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bitDepth: buf[24], colorType: ct,
    colorTypeName: { 0: 'gray', 2: 'rgb', 3: 'indexed', 4: 'gray+alpha', 6: 'rgba' }[ct], interlace: buf[28] };
}
function kmeans(px, k, iters = 12) {
  let cs = []; for (let i = 0; i < k; i++) cs.push(px[Math.floor((i + 0.5) * px.length / k)].slice());
  for (let it = 0; it < iters; it++) {
    const sum = cs.map(() => [0, 0, 0, 0]);
    for (const p of px) { let b = 0, bd = 1e12;
      for (let j = 0; j < k; j++) { const d = (p[0]-cs[j][0])**2+(p[1]-cs[j][1])**2+(p[2]-cs[j][2])**2; if (d < bd) { bd = d; b = j; } }
      sum[b][0]+=p[0]; sum[b][1]+=p[1]; sum[b][2]+=p[2]; sum[b][3]++; }
    cs = cs.map((c, j) => sum[j][3] ? [sum[j][0]/sum[j][3], sum[j][1]/sum[j][3], sum[j][2]/sum[j][3], sum[j][3]] : c);
  }
  return cs;
}
for (const dir of ['brand', 'reference']) for (const f of fs.readdirSync(path.join(root, dir))) {
  const p = path.join(root, dir, f); const buf = fs.readFileSync(p);
  const meta = await sharp(buf).metadata();
  const raw = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = raw; const n = info.width * info.height;
  const hist = new Array(8).fill(0); let pureBlackTransparent = 0; const sample = [];
  const stride = Math.max(1, Math.floor(n / 60000));
  for (let i = 0; i < n; i++) { const a = data[i*4+3]; hist[a >> 5]++;
    if (a === 0 && data[i*4] === 0 && data[i*4+1] === 0 && data[i*4+2] === 0) pureBlackTransparent++;
    if (i % stride === 0 && a > 0) sample.push([data[i*4], data[i*4+1], data[i*4+2]]); }
  const cs = kmeans(sample, 8).sort((a, b) => b[3] - a[3]);
  // snap each centroid to nearest real pixel coordinate
  const snapped = cs.map(c => { let best = null, bd = 1e12;
    for (let i = 0; i < n; i += 7) { if (data[i*4+3] < 200) continue;
      const d = (data[i*4]-c[0])**2+(data[i*4+1]-c[1])**2+(data[i*4+2]-c[2])**2;
      if (d < bd) { bd = d; best = i; } }
    const x = best % info.width, y = Math.floor(best / info.width);
    const hex = '#' + [0,1,2].map(k => data[best*4+k].toString(16).padStart(2, '0')).join('');
    return { hex, x, y, share: +(c[3] / sample.length).toFixed(3) }; });
  out[`${dir}/${f}`] = { bytes: buf.length, format: meta.format, ihdr: ihdr(buf), hasAlphaChannel: meta.hasAlpha, size: [info.width, info.height],
    alphaHist8: hist, pureBlackTransparentPx: pureBlackTransparent, palette: snapped };
}
fs.mkdirSync(path.join(root, 'scripts', '.out'), { recursive: true });
fs.writeFileSync(path.join(root, 'scripts', '.out', 'assets.json'), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, v.format, v.size.join('x'), 'IHDR', JSON.stringify(v.ihdr), 'alphaCh', v.hasAlphaChannel, 'hist', v.alphaHist8.join(','), 'blackT', v.pureBlackTransparentPx, '\n   ', v.palette.slice(0, 6).map(c => `${c.hex}@${c.x},${c.y}:${c.share}`).join(' '));
