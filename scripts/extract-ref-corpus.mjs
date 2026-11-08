// Usage: node scripts/extract-ref-corpus.mjs <reference-bundle.js> <reference.html>
// Pulls UI copy out of the reference bundle into scripts/data/ref-corpus.txt, used only by the copy-distance gate.
import fs from 'node:fs';
import path from 'node:path';
const [js, html] = process.argv.slice(2);
const bundle = fs.readFileSync(js, 'utf8');
const skip = /three|webgl|texture|buffer|matrix|camera|geometry|uniform|shader|react|loader|attribute|vertex|orbitcontrols|object3d|deprecated|typed array|curve|mesh|vector|quaternion|material|uint|float32|framebuffer|extension|lucide|\bdoc-/i;
const patterns = [
  /"((?:[^"\\\n]|\\.){12,400})"/g,
  /"([A-Z][^"\\\n]{10,300}[.!?])"/g,
  /children:"([^"\\\n]{4,300})"/g,
  /(?:label|title|placeholder|description|aria-label):"([^"\\\n]{4,300})"/g,
  /`([^`\\\n$]{12,300})`/g
];
const out = new Set();
for (const re of patterns) {
  for (const m of bundle.matchAll(re)) {
    const s = m[1].replace(/\\n/g, ' ').trim();
    if (!/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s)) continue;
    if (/[{}();=<>\\_$]|https?:|\.js\b|\.css\b|\bfunction\b/.test(s)) continue;
    if (skip.test(s)) continue;
    out.add(s);
  }
}
const h = fs.readFileSync(html, 'utf8');
for (const m of h.matchAll(/(?:<title>|content=")([^"<]+)/g)) out.add(m[1].trim());
const dest = path.resolve(import.meta.dirname, 'data', 'ref-corpus.txt');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, [...out].join('\n') + '\n');
console.log('corpus lines', out.size);
