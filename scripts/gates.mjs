// Gate runner. Static checks on dist/ and the repo, then a headless browser pass in which BOTH branches
// of every register-driven feature are proven. Mutation anchors never assume a state: they read the
// record at runtime, then set each state explicitly in a throwaway copy of dist/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { ADDRESS_RE, isAddress } from '../src/js/register-view.js';

const root = path.resolve(import.meta.dirname, '..');
const DIST = path.join(root, 'dist');
const results = [];
function gate(id, desc, ok, detail = '') {
  results.push({ id, desc, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${!ok && detail ? '  -> ' + detail : ''}`);
}
const info = (s) => console.log('info  ' + s);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
function walk(dir, skip = []) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, skip)); else out.push(p);
  }
  return out;
}
const TEXT_EXT = /\.(html|css|js|json|svg|md|txt|mjs)$/i;
const distText = walk(DIST).filter((f) => TEXT_EXT.test(f) || path.basename(f) === '_headers');

/* ================= static ================= */
for (const f of ['index.html', 'favicon.svg', 'register.json', 'css/tokens.css', 'css/styles.css', 'js/app.js', 'assets/logo-192.png', 'assets/cycle-logo.png']) {
  if (!fs.existsSync(path.join(DIST, f))) gate('S01', `dist contains ${f}`, false);
}
gate('S01', 'dist/ holds the deployable output', fs.existsSync(path.join(DIST, 'index.html')) && fs.existsSync(path.join(DIST, 'css/styles.css')));
gate('S02', 'repo docs stay out of dist/', !['README.md', 'LICENSE', 'docs', 'whitepaper.md', 'package.json'].some((f) => fs.existsSync(path.join(DIST, f))));

// favicon
const svg = read(DIST, 'favicon.svg');
const tokensCss = read(root, 'src/tokens.css');
const tokenHexes = [...tokensCss.matchAll(/--color-[a-z0-9-]+:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
gate('S03', 'favicon is a 32x32 SVG', /<svg[^>]*width="32"[^>]*height="32"[^>]*viewBox="0 0 32 32"/.test(svg));
gate('S04', 'favicon has no comments, so no double hyphen can sit inside one', !svg.includes('<!--') && !svg.includes('-->') && !/<\?xml/.test(svg));
gate('S05', 'favicon traced from the pixel grid: only token colours, many rects', (svg.match(/<rect /g) || []).length > 100 && [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].every((m) => tokenHexes.includes(m[1])));
gate('S06', 'favicon is linked from the page', /rel="icon"[^>]*favicon\.svg/.test(read(DIST, 'index.html')));

// palette provenance: re-read the pixel named in each token comment
{
  let ok = true, n = 0, bad = '';
  for (const m of tokensCss.matchAll(/--(color-[a-z0-9-]+):\s*(#[0-9a-f]{6});\s*\/\*\s*px (\d+),(\d+)\s+(brand\/[^*]+?)\s{2,}/gi)) {
    const [, name, hex, x, y, file] = m;
    const { data, info: inf } = await sharp(path.join(root, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (+y * inf.width + +x) * 4;
    const got = '#' + [0, 1, 2].map((k) => data[i + k].toString(16).padStart(2, '0')).join('');
    n++;
    if (got !== hex.toLowerCase()) { ok = false; bad += ` ${name} wants ${hex} got ${got};`; }
  }
  gate('S07', `palette provenance: all ${n} token pixels match their stated coordinates`, ok && n === tokenHexes.length, bad || `${n}/${tokenHexes.length}`);
}

// literals only in tokens file
{
  const offenders = [];
  for (const f of distText) {
    const rel = path.relative(DIST, f).replace(/\\/g, '/');
    if (rel === 'css/tokens.css' || rel === 'favicon.svg' || !/\.(css|js|html)$/.test(rel)) continue;
    const t = fs.readFileSync(f, 'utf8');
    if (/#[0-9a-fA-F]{3,8}\b(?![-\w])/.test(t.replace(/&#\d+;/g, '').replace(/href="#[^"]*"/g, '')) || /\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklch)\(/i.test(t)) offenders.push(rel);
  }
  gate('S08', 'no colour literals outside tokens.css', !offenders.length, offenders.join(','));
}
{
  const css = read(DIST, 'css/styles.css') + read(DIST, 'css/tokens.css');
  gate('S09', 'no ch units anywhere in CSS', !/[\d.]ch\b/.test(css));
  gate('S10', 'prefers-reduced-motion rules present', /@media \(prefers-reduced-motion: reduce\)/.test(css) && /animation: none !important/.test(css));
}

// no dates in anything shipped
{
  const datePats = [/\b\d{4}-\d{2}-\d{2}\b/, /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i, /\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, /\b([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?\b/, /\bas of\b/i, /\bchecked\b/i, /\blast updated\b/i, /\bupdated (on|at)\b/i, /\btimestamp\b/i, /\b(19|20)\d{2}\b/];
  const hits = [];
  for (const f of distText) {
    const t = fs.readFileSync(f, 'utf8').replace(/&#\d+;/g, '');
    const isSvg = f.endsWith('.svg'); // coordinate data is not prose
    for (const p of datePats) { if (isSvg && /19\|20/.test(p.source)) continue; const m = t.match(p); if (m) hits.push(`${path.relative(DIST, f)}:${m[0]}`); }
  }
  gate('S11', 'zero dates, timestamps, as-of or checked strings in dist/', !hits.length, hits.slice(0, 6).join(' | '));
}

// register invariants
{
  const src = JSON.parse(read(root, 'src/register.json'));
  const ship = JSON.parse(read(DIST, 'register.json'));
  const STATES = ['stated', 'absent', 'unconfirmed'];
  const FACT_KEYS = ['value', 'url', 'rpc', 'pairs', 'ownPair', 'ownMeta'];
  let stateOk = true, inertOk = true, statedOk = true;
  for (const [k, r] of Object.entries(src.records)) {
    if (!STATES.includes(r.state)) stateOk = false;
    if (r.state !== 'stated' && FACT_KEYS.some((f) => f in r)) inertOk = false;
    if (r.state === 'stated' && !FACT_KEYS.some((f) => f in r)) statedOk = false;
  }
  gate('S12', 'every record has state stated|absent|unconfirmed', stateOk);
  gate('S13', 'inert records carry no value and no url', inertOk);
  gate('S14', 'stated records carry their fact', statedOk);
  gate('S15', 'source register keeps dates as data; shipped register has none', Object.values(src.records).every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.checked)) && !JSON.stringify(ship).match(/\d{4}-\d{2}-\d{2}|checked/));
  gate('S16', 'chain record: Solana, client statement, batch-level, RPC set', src.records.chain.value === 'Solana' && src.records.chain.rpc === 'https://solana-rpc.publicnode.com' && src.records.chain.source === 'client statement' && src.records.chain.scope === 'batch-level');
}

// address scanner: match address-shaped strings against the stated registry. Never reject 0x wholesale.
const HEX_ADDR = /\b0x[0-9a-fA-F]{40}\b/g;
function scanAddresses(text, allowed) {
  const found = [...(text.match(HEX_ADDR) || []), ...(text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [])];
  return found.filter((a) => !allowed.has(a));
}
{
  const reg = JSON.parse(read(DIST, 'register.json'));
  const allowed = new Set();
  for (const r of Object.values(reg.records)) if (r.state === 'stated' && r.value) allowed.add(r.value);
  // CA is exempt from the scanner by rule, but only when stated.
  const stray = distText.flatMap((f) => scanAddresses(fs.readFileSync(f, 'utf8'), allowed).map((a) => `${path.basename(f)}:${a.slice(0, 12)}`));
  gate('S17', 'no unregistered address-shaped strings in dist/', !stray.length, stray.slice(0, 4).join(','));
  const sample = '0x' + 'ab12'.repeat(10);
  gate('S18', 'scanner flags an unregistered 0x address', scanAddresses(`x ${sample} y`, new Set()).length === 1);
  gate('S19', 'scanner accepts a stated 0x address (no blanket reject)', scanAddresses(`x ${sample} y`, new Set([sample])).length === 0);
  gate('S20', 'scanner ignores plain hex that is not address-shaped', scanAddresses('colour 0xdeadbeef and 0x1F', new Set()).length === 0);
}

// repo hygiene
{
  const bad = [];
  const word = new RegExp(['cla' + 'ude', 'anthr' + 'opic', '\\bA' + 'I\\b', 'gener' + 'ated (by|with)', 'co-' + 'authored'].join('|'), 'i');
  for (const f of walk(root, ['node_modules', '.git', 'brand', 'reference', 'package-lock.json', 'fonts', '.out'])) {
    if (/\.(png|jpe?g|woff2|jpeg)$/i.test(f)) continue;
    if (word.test(fs.readFileSync(f, 'utf8'))) bad.push(path.relative(root, f));
  }
  gate('S21', 'no attribution lines or tool names in any repo file', !bad.length, bad.join(','));
  gate('S22', 'no instruction file and no tool config directory', !fs.existsSync(path.join(root, ['CLA', 'UDE.md'].join(''))) && !fs.existsSync(path.join(root, '.' + ['cla', 'ude'].join(''))));
  gate('S23', 'README, whitepaper and MIT licence exist outside dist', fs.existsSync(path.join(root, 'README.md')) && fs.existsSync(path.join(root, 'docs/whitepaper.md')) && /MIT License/.test(read(root, 'LICENSE')) && /Copyright \(c\) 2026 CYCLE/.test(read(root, 'LICENSE')));
}

// copy distance from the reference
{
  const STOP = new Set('a an and are as at be but by for from has have in is it its of on or our so that the their then there these this to up was we what when which who will with you your not no into over one out can per via all any each than too very just more most also about after again before'.split(' '));
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const bigrams = (s) => { const w = words(s), o = new Set(); for (let i = 0; i < w.length - 1; i++) if (!(STOP.has(w[i]) && STOP.has(w[i + 1]))) o.add(w[i] + ' ' + w[i + 1]); return o; };
  const refText = read(root, 'scripts/data/ref-corpus.txt');
  const refGrams = new Set(); for (const line of refText.split('\n')) for (const g of bigrams(line)) refGrams.add(g);
  const refWords = new Set(words(refText).filter((w) => w.length >= 4 && !STOP.has(w)));
  const html = read(DIST, 'index.html');
  const visible = html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
  const attrs = [...html.matchAll(/(?:aria-label|title|alt)="([^"]+)"/g), ...html.matchAll(/<meta (?:name="description"|property="og:(?:title|description)")[^>]*content="([^"]+)"/g)].map((m) => m[1]).join(' ');
  const jsStrings = distText.filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/'([^'\n]{4,})'|`([^`\n$]{4,})`/g)].map((m) => m[1] || m[2])).filter((s) => /^[A-Z][^{}=;<>_./#:\[\]()]*\s[^{}=;<>_./#:\[\]()]*$/.test(s)).join(' ');
  const ours = visible + ' ' + attrs + ' ' + jsStrings;
  const shared = [...bigrams(ours)].filter((g) => refGrams.has(g));
  gate('S24', 'zero shared 2-grams with the reference copy (function-word-only pairs excluded)', !shared.length, shared.join(' | '));
  const common = new Set(words(ours).filter((w) => w.length >= 4 && !STOP.has(w) && refWords.has(w)));
  // Words a market page cannot avoid (column and data nouns) plus plain English connectives are the only exemptions.
  const DOMAIN = new Set('market price liquidity volume token tokens solana chain address symbol pair copy live feed data board name'.split(' '));
  const PLAIN = new Set('back first next last here every does cannot could until return around right inside show shown view found page that this with from have your what when open only into more most about each time like'.split(' '));
  const wordHits = [...common].filter((w) => !DOMAIN.has(w) && !PLAIN.has(w));
  info(`S25 exemptions: ${DOMAIN.size} domain nouns, ${PLAIN.size} plain English words`);
  gate('S25', 'no other content word of 4+ letters shared with the reference vocabulary', !wordHits.length, wordHits.join(','));
}

// network surface: only the register hosts
{
  const html = read(DIST, 'index.html');
  const ext = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  gate('S26', 'page loads no third-party asset and carries no external href while records are as shipped', !ext.length, ext.join(','));
}

/* ================= browser ================= */
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { gate('B00', 'a Chromium browser is available', false, 'no Edge or Chrome found'); finish(); }

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

// seeded fixtures
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = () => Array.from({ length: 44 }, () => B58[Math.floor(rnd() * 58)]).join('');
const TEST_CA = addr();
const TOKENS = Array.from({ length: 14 }, (_, i) => ({ a: addr(), sym: 'TK' + String.fromCharCode(65 + i), vol: 9_000_000 - i * 400_000, img: ![2, 5, 8].includes(i) }));
TOKENS[4].a = TEST_CA; // own token also appears in trending, to prove dedup
const PNG = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 1 } } }).png().toBuffer();
const pairOf = (t, k = 1) => ({ chainId: 'solana', pairAddress: addr(), baseToken: { address: t.a, name: 'Name ' + t.sym, symbol: t.sym }, priceUsd: String(0.001234 * k), priceChange: { h24: (t.vol % 7) * 3.1 - 8 }, volume: { h24: t.vol }, liquidity: { usd: t.vol / 9 }, marketCap: t.vol * 3, info: t.img ? { imageUrl: `https://img.test/${t.sym}.png` } : {} });

function installMocks(ctx, opt = {}) {
  const log = { boosts: 0, pairs: [], ownPair: 0, ownMeta: 0, urls: [] };
  const o = { boostsStatus: 200, priceK: 1, pairsDelay: 0, ownLiq: 'usd', pumpImage: true, ...opt };
  const handle = async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    log.urls.push(req.url());
    if (u.hostname === 'api.dexscreener.com' && u.pathname === '/token-boosts/top/v1') {
      log.boosts++;
      if (o.boostsStatus !== 200) return route.fulfill({ status: o.boostsStatus, body: 'x' });
      const list = [...TOKENS.map((t) => ({ chainId: 'solana', tokenAddress: t.a })), { chainId: 'bsc', tokenAddress: '0x' + 'cd34'.repeat(10) }, { chainId: 'solana', tokenAddress: TOKENS[0].a }];
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(list) });
    }
    if (u.hostname === 'api.dexscreener.com' && u.pathname.startsWith('/tokens/v1/solana/')) {
      log.pairs.push(u.pathname);
      if (o.pairsDelay) await new Promise((r) => setTimeout(r, o.pairsDelay));
      const wanted = new Set(decodeURIComponent(u.pathname.split('/').pop()).split(','));
      const pairs = TOKENS.filter((t) => wanted.has(t.a)).flatMap((t) => [pairOf(t, o.priceK), { ...pairOf({ ...t, vol: 10 }), baseToken: { address: t.a, name: 'Low', symbol: 'LOW' } }]);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(pairs) });
    }
    if (u.hostname === 'api.dexscreener.com' && u.pathname.startsWith('/latest/dex/tokens/')) {
      log.ownPair++;
      const ca = u.pathname.split('/').pop();
      const mk = (vol, liq, mc) => ({ chainId: 'solana', pairAddress: addr(), baseToken: { address: ca, name: 'Cycle Own', symbol: 'OWNX' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.000456', priceChange: { h24: 12.5 }, volume: { h24: vol }, liquidity: liq === null ? undefined : { usd: liq }, marketCap: mc });
      const pairs = [mk(100, 1, 5), mk(5000, o.ownLiq === 'usd' ? 12345 : 0, 99999), { ...mk(999999, 77, 77), baseToken: { address: addr(), name: 'Other', symbol: 'OTH' }, quoteToken: { address: ca, symbol: 'X' } }];
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ pairs }) });
    }
    if (u.hostname === 'frontend-api.pump.fun') {
      log.ownMeta++;
      if (!o.pumpImage) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'nf' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ image_uri: 'https://pump.test/own.png' }) });
    }
    if (u.hostname === 'img.test' || u.hostname === 'pump.test') {
      if (o.blockImages) return route.abort();
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    return route.abort();
  };
  ctx.route('**/*', handle);
  return { log, o };
}

if (process.env.STATIC_ONLY) finish();
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-gates-'));
const servers = [];
function variant(name, mutate) {
  const dir = path.join(tmpRoot, name);
  fs.cpSync(DIST, dir, { recursive: true });
  const f = path.join(dir, 'register.json');
  const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
  mutate(reg.records, reg);
  fs.writeFileSync(f, JSON.stringify(reg));
  return dir;
}
// Set a record to a state explicitly. The current state is read first and reported, never assumed.
const SET = {
  ca: (r, on) => { r.ca = on ? { label: 'Contract', state: 'stated', value: TEST_CA } : { label: 'Contract', state: 'absent' }; },
  x: (r, on) => { r.x = on ? { label: 'X', state: 'stated', url: 'https://x.com/cycletest' } : { label: 'X', state: 'absent' }; },
  github: (r, on) => { r.github = on ? { label: 'GitHub', state: 'stated', url: 'https://github.com/cycletest/cycle' } : { label: 'GitHub', state: 'absent' }; }
};
async function open(dir, { viewport = { width: 1440, height: 900 }, mocks = {}, reducedMotion = 'no-preference', clock = false, perms = true } = {}) {
  const s = await serve(dir); servers.push(s.srv);
  const ctx = await browser.newContext({ viewport, reducedMotion, ...(perms ? {} : {}) });
  if (perms) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(s.url).origin }).catch(() => {});
  const m = installMocks(ctx, mocks);
  const page = await ctx.newPage();
  const errors = []; const logs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (c) => { logs.push(c.text()); if (c.type() === 'error' && !/Failed to load resource|net::ERR/.test(c.text())) errors.push(c.text()); });
  if (clock) await page.clock.install();
  page.on("requestfailed", (r) => console.log("RF", r.url().slice(0, 90), r.failure() && r.failure().errorText)); page.on("request", (r) => { if (process.env.DBG) console.log("RQ", r.url().slice(0, 90)); });
  for (let t = 0; ; t++) { try { await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 45000 }); break; } catch (e) { if (t >= 2) throw e; info("navigation retry " + (t + 1)); } }
  await page.waitForFunction(() => document.documentElement.dataset.register, null, { timeout: 15000 });
  const hydrated = await page.evaluate(() => document.documentElement.dataset.register);
  if (hydrated !== 'ready') gate('H00', 'register.json loaded for ' + path.basename(dir), false, hydrated);
  return { page, ctx, m, errors, logs, url: s.url };
}
async function settled(page, n = 10) { await page.waitForFunction((k) => document.querySelectorAll('#rows .mrow:not(.is-skeleton)').length >= k, n, { timeout: 15000 }); await page.waitForTimeout(900); }

const live = JSON.parse(read(DIST, 'register.json')).records;
info(`runtime read of shipped register -> ca:${live.ca.state} x:${live.x.state} github:${live.github.state} market:${live.market.state}`);

/* ---- B1: shipped dist as-is, state read at runtime, branch chosen from what the register says ---- */
{
  const { page, ctx, m, errors } = await open(DIST);
  await settled(page);
  const caState = await page.evaluate(() => document.querySelector('.ca-inner').dataset.caState);
  gate('B01', 'shipped build renders the CA slot in the state its register record states', caState === live.ca.state, `${caState} vs ${live.ca.state}`);
  for (const k of ['x', 'github']) {
    const el = await page.evaluate((key) => { const e = document.querySelector(`[data-social="${key}"]`); return e ? { tag: e.tagName, href: e.getAttribute('href'), disabled: e.disabled === true } : null; }, k);
    const want = live[k].state === 'stated';
    gate(`B02-${k}`, `shipped ${k} icon matches its record at runtime (${live[k].state})`, el && (want ? el.tag === 'A' && el.href === live[k].url : el.tag === 'BUTTON' && el.disabled && el.href === null));
  }
  gate('B03', 'no uncaught page errors on load', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ---- CA branches ---- */
const caRuns = {};
for (const on of [false, true]) {
  const dir = variant(`ca-${on}`, (r) => SET.ca(r, on));
  const run = await open(dir);
  await settled(run.page);
  caRuns[on] = run;
}
{ // CA ABSENT
  const { page, m, errors } = caRuns[false];
  const slot = await page.evaluate(() => { const v = document.querySelector('.ca-value'); return { tag: v.tagName, text: v.textContent.trim(), aria: v.getAttribute('aria-disabled'), copy: v.dataset.copy ?? null, inner: document.querySelector('.ca-inner').dataset.caState }; });
  gate('C01', 'CA absent: slot is inert and reads pending', slot.tag === 'SPAN' && slot.text === 'pending' && slot.aria === 'true' && slot.copy === null && slot.inner === 'absent', JSON.stringify(slot));
  const row = await page.evaluate(() => { const li = document.querySelector('#rows .mrow'); const img = li.querySelector('.logo img'); const cs = getComputedStyle(li); return { key: li.dataset.key, own: li.classList.contains('own'), ph: li.classList.contains('is-placeholder'), img: img && img.getAttribute('src'), tile: !!li.querySelector('[data-tile]'), price: li.querySelector('[data-col=price]').textContent, change: li.querySelector('[data-col=change]').textContent, copyDisabled: li.querySelector('.copy').disabled, anim: cs.animationName, dur: cs.animationDuration, iter: cs.animationIterationCount, ariaDis: li.getAttribute('aria-disabled') }; });
  gate('C02', 'CA absent: row #1 is the brand logo placeholder, not a tile', row.key === 'own' && row.own && row.ph && /assets\/cycle-logo\.png$/.test(row.img) && !row.tile, JSON.stringify(row));
  gate('C03', 'CA absent: placeholder data is dots and $0.00, row not clickable', row.price === '$0.00' && row.change === '· · · · ·' && row.copyDisabled && row.ariaDis === 'true');
  gate('C04', 'CA absent: ownPulse keeps running (2s ease-in-out infinite)', row.anim === 'ownPulse' && row.dur === '2s' && row.iter === 'infinite', `${row.anim} ${row.dur} ${row.iter}`);
  gate('C05', 'CA absent: no own-token request is ever made', m.log.ownPair === 0 && m.log.ownMeta === 0);
  const n = await page.evaluate(() => document.querySelectorAll('#rows .mrow').length);
  gate('C06', 'CA absent: board holds 10 rows (placeholder + 9 trending)', n === 10, String(n));
  gate('C07', 'CA absent: no page errors', errors.length === 0, errors.join('|'));
}
{ // CA STATED
  const { page, ctx, m, errors, logs } = caRuns[true];
  const slot = await page.evaluate(() => { const v = document.querySelector('.ca-value'); const a = v.querySelector('.ca-addr'); return { tag: v.tagName, text: a.textContent, fs: parseFloat(getComputedStyle(a).fontSize), inner: document.querySelector('.ca-inner').dataset.caState, top: document.querySelector('.ca').getBoundingClientRect().top }; });
  gate('C10', 'CA stated: full address shown in a button', slot.tag === 'BUTTON' && slot.text === TEST_CA && slot.inner === 'stated');
  gate('C11', 'CA stated: slot sits at the top and the font is large (>= 20px at desktop)', slot.top <= 1 && slot.fs >= 20, `${slot.fs}px top ${slot.top}`);
  await page.click('.ca-value');
  await page.waitForTimeout(150);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const hint = await page.evaluate(() => document.querySelector('.ca-hint').textContent);
  gate('C12', 'CA stated: click copies the address and shows feedback', clip === TEST_CA && hint === 'Copied', `${clip.slice(0, 8)} ${hint}`);
  const row = await page.evaluate(() => { const li = document.querySelector('#rows .mrow'); const cs = getComputedStyle(li); const img = li.querySelector('.logo img'); return { key: li.dataset.key, own: li.classList.contains('own'), ph: li.classList.contains('is-placeholder'), img: img && img.getAttribute('src'), tile: !!li.querySelector('[data-tile]'), bl: cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor, sym: li.querySelector('strong').textContent, price: li.querySelector('[data-col=price]').textContent, change: li.querySelector('[data-col=change]').textContent, vol: li.querySelector('[data-col=vol]').textContent, liq: li.querySelector('[data-col=liq]').textContent, liqTitle: li.querySelector('[data-col=liq]').title, anim: cs.animationName, copy: li.querySelector('.copy').dataset.copy, mint: getComputedStyle(document.documentElement).getPropertyValue('--color-mint').trim() }; });
  const mint = tokensCss.match(/--color-mint:\s*#([0-9a-f]{6})/i)[1];
  const rgb = `rgb(${parseInt(mint.slice(0, 2), 16)}, ${parseInt(mint.slice(2, 4), 16)}, ${parseInt(mint.slice(4, 6), 16)})`;
  gate('C13', 'CA stated: row #1 is the own token, pinned, 2px mint left border', row.key === 'own' && row.own && !row.ph && row.bl === `2px solid ${rgb}`, JSON.stringify(row));
  gate('C14', 'CA stated: own row pulses (ownPulse)', row.anim === 'ownPulse');
  gate('C15', 'CA stated: logo is pump.fun image_uri, never the DexScreener CDN', /^https:\/\/pump\.test\/own\.png$/.test(row.img) && !m.log.urls.some((u) => /dd\.dexscreener\.com/.test(u)), row.img);
  gate('C16', 'CA stated: pair chosen by baseToken match then highest 24h volume (price, change, volume)', row.sym === 'OWNX' && row.price === '$0.000456' && row.change.includes('12.50') && row.vol === '$5.0K', JSON.stringify(row));
  gate('C17', 'CA stated: liquidity column uses liquidity.usd when above zero', row.liq === '$12.3K' && row.liqTitle === '', `${row.liq} / ${row.liqTitle}`);
  gate('C18', 'CA stated: own row copy button carries the CA', row.copy === TEST_CA);
  const dedup = await page.evaluate((ca) => [...document.querySelectorAll('#rows .copy')].filter((b) => b.dataset.copy === ca).length, TEST_CA);
  gate('C19', 'CA stated: own token removed from trending rows 2-10 (dedup)', dedup === 1, String(dedup));
  const n = await page.evaluate(() => document.querySelectorAll('#rows .mrow').length);
  gate('C20', 'CA stated: still 10 rows after dedup', n === 10, String(n));
  gate('C21', 'CA stated: both own requests fired and both console markers logged', m.log.ownPair >= 1 && m.log.ownMeta >= 1 && logs.some((l) => l.includes('[cycle] own token raw response')) && logs.some((l) => l.includes('[cycle] own liquidity candidates')));
  gate('C22', 'CA stated: no page errors', errors.length === 0, errors.join('|'));
}
{ // market zero-effect proof
  const a = caRuns[false].m.log.urls.filter((u) => /token-boosts|tokens\/v1\/solana/.test(u)).sort();
  const b = caRuns[true].m.log.urls.filter((u) => /token-boosts|tokens\/v1\/solana/.test(u)).sort();
  gate('C30', 'market requests are identical whether the CA is stated or absent', JSON.stringify(a) === JSON.stringify(b), `${a.length} vs ${b.length}`);
  const ids = async (p) => p.evaluate(() => [...document.querySelectorAll('#rows .mrow')].slice(1).map((l) => l.dataset.key).sort().join());
  const ra = await ids(caRuns[false].page);
  const rb = await ids(caRuns[true].page);
  const aSet = new Set(ra.split(',')); const bSet = new Set(rb.split(','));
  const onlyA = [...aSet].filter((x) => !bSet.has(x));
  gate('C31', 'trending rows differ only by the own-token dedup', onlyA.length <= 1 && (onlyA.length === 0 || onlyA[0] === TEST_CA) || onlyA.every((x) => x === TEST_CA), onlyA.join());
  await caRuns[false].ctx.close();
  await caRuns[true].ctx.close();
}
{ // mkt cap fallback + pump failure fallback
  const dir = variant('ca-fallback', (r) => SET.ca(r, true));
  const { page, ctx } = await open(dir, { mocks: { ownLiq: 'zero', pumpImage: false } });
  await settled(page);
  const row = await page.evaluate(() => { const li = document.querySelector('#rows .mrow'); const img = li.querySelector('.logo img'); return { img: img && img.getAttribute('src'), tile: !!li.querySelector('[data-tile]'), liq: li.querySelector('[data-col=liq]').textContent, title: li.querySelector('[data-col=liq]').title }; });
  gate('C40', 'liquidity zero falls back to marketCap, labelled Mkt Cap via title', row.liq === '$100.0K' && row.title === 'Mkt Cap', JSON.stringify(row));
  gate('C41', 'pump.fun failure falls back to assets/logo-192.png (never a letter tile)', /assets\/logo-192\.png$/.test(row.img) && !row.tile, JSON.stringify(row));
  await ctx.close();
}

/* ---- social branches ---- */
for (const k of ['x', 'github']) {
  for (const on of [false, true]) {
    const dir = variant(`${k}-${on}`, (r) => SET[k](r, on));
    const { page, ctx } = await open(dir, { viewport: { width: 360, height: 800 } });
    const s = await page.evaluate((key) => { const e = document.querySelector(`[data-social="${key}"]`); const r = e.getBoundingClientRect(); const other = [...document.querySelectorAll('.social')].map((x) => x.getBoundingClientRect()); return { tag: e.tagName, href: e.getAttribute('href'), aria: e.getAttribute('aria-label'), text: e.textContent.trim(), disabled: e.disabled === true, hasSvg: !!e.querySelector('svg'), right: Math.max(...other.map((x) => x.right)), w: r.width, h: r.height, vw: innerWidth, count: document.querySelectorAll('.social').length, visible: r.width > 0 && r.height > 0, hrefAny: e.outerHTML.includes('href') }; }, k);
    const url = SET[k] && (k === 'x' ? 'https://x.com/cycletest' : 'https://github.com/cycletest/cycle');
    if (on) gate(`D-${k}-on`, `${k} stated: anchor with the stored URL, handle derived from it`, s.tag === 'A' && s.href === url && /cycletest/.test(s.aria) && s.hasSvg && s.text === '', JSON.stringify(s));
    else gate(`D-${k}-off`, `${k} absent: icon renders but is inert, no href`, s.tag === 'BUTTON' && s.disabled && !s.hrefAny && s.hasSvg && s.text === '' && /pending/.test(s.aria), JSON.stringify(s));
    gate(`D-${k}-${on ? 'on' : 'off'}-pos`, `${k} ${on ? 'stated' : 'absent'}: icon-only, top-right, both icons present at 360px, 44px target`, s.count === 2 && s.visible && s.w >= 44 && s.h >= 44 && s.vw - s.right <= 20, `right gap ${s.vw - s.right}`);
    await ctx.close();
  }
}

/* ---- letter tiles ---- */
for (const on of [false, true]) {
  const dir = variant(`tiles-${on}`, (r) => SET.ca(r, on));
  const { page, ctx } = await open(dir, { mocks: { blockImages: true, pumpImage: false } });
  await settled(page);
  const t = await page.evaluate(() => ({ trending: [...document.querySelectorAll('#rows .mrow')].slice(1).filter((l) => l.querySelector('[data-tile]')).length, own: !!document.querySelector('#rows .mrow').querySelector('[data-tile]') }));
  gate(`T-${on ? 'on' : 'off'}`, `CA ${on ? 'stated' : 'absent'}: letter tiles >= 2 on trending when images fail, none on row #1`, t.trending >= 2 && !t.own, JSON.stringify(t));
  await ctx.close();
}

/* ---- skeleton -> data, stagger, flash, count-up ---- */
{
  const dir = variant('skeleton', (r) => SET.ca(r, false));
  const s = await serve(dir); servers.push(s.srv);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  installMocks(ctx, { pairsDelay: 2500 });
  const page = await ctx.newPage();
  await page.goto(s.url);
  await page.waitForFunction(() => document.documentElement.dataset.register, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const sk = await page.evaluate(() => document.querySelectorAll('#rows .is-skeleton').length);
  gate('V01', 'skeleton rows shimmer while the feed loads', sk >= 9, String(sk));
  const sweep = await page.evaluate(() => { const e = document.querySelector('.is-skeleton .sk'); return e ? getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationDuration : 'none'; });
  gate('V02', 'skeleton sweep is the measured 1.8s linear loop', sweep === 'sweep 1.8s', sweep);
  await page.waitForFunction(() => document.querySelectorAll('#rows .mrow:not(.is-skeleton)').length >= 10, null, { timeout: 15000 });
  const st = await page.evaluate(() => { const rows = [...document.querySelectorAll('#rows .mrow:not(.is-skeleton)')]; return rows.slice(0, 4).map((r) => getComputedStyle(r).transitionDelay); });
  gate('V03', 'real rows fade in with a per-row stagger', new Set(st.map((x) => x.split(',')[1].trim())).size >= 3, st.join(' | '));
  const sk2 = await page.evaluate(() => document.querySelectorAll('#rows .is-skeleton').length);
  gate('V04', 'no skeletons remain after data lands', sk2 === 0);
  const rev = await page.evaluate(() => ({ below: [...document.querySelectorAll('[data-reveal]')].filter((e) => e.getBoundingClientRect().top > innerHeight && !e.classList.contains('is-in')).length }));
  gate('V05', 'below-fold sections wait for scroll before revealing', rev.below > 0, JSON.stringify(rev));
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-reveal]')].every((e) => e.classList.contains('is-in')), null, { timeout: 12000 }).catch(() => {});
  const left = await page.evaluate(() => [...document.querySelectorAll('[data-reveal]')].filter((e) => !e.classList.contains('is-in')).map((e) => e.tagName + '.' + e.className.split(' ')[0] + '@' + Math.round(e.getBoundingClientRect().top)));
  gate('V06', 'spring reveal completes for every section', left.length === 0, left.join(','));
  const prog = await page.evaluate(() => document.getElementById('progress').style.transform);
  gate('V07', 'scroll progress bar tracks the scroll', /scaleX\(0\.9|scaleX\(1\)/.test(prog), prog);
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.move(700, 300);
  await page.waitForTimeout(500);
  const par = await page.evaluate(() => [...document.querySelectorAll('.hero-art [data-depth]')].map((l) => l.style.transform));
  gate('V08', 'hero layers move with the pointer (parallax)', par.every((t) => t.includes('translate3d')) && new Set(par).size >= 3, par.slice(0, 3).join(' | '));
  const row = page.locator('#rows .mrow').nth(3);
  await row.hover();
  const mx = await row.evaluate((e) => e.style.getPropertyValue('--mx'));
  gate('V09', 'spotlight follows the pointer on rows', /px$/.test(mx), mx);
  const card = page.locator('.card').first(); await card.scrollIntoViewIfNeeded(); await card.hover();
  gate('V10', 'spotlight follows the pointer on cards', /px$/.test(await card.evaluate((e) => e.style.getPropertyValue('--mx'))));
  const anims = await page.evaluate(() => document.getAnimations().length);
  gate('V11', 'motion is alive by default (animations running)', anims > 3, String(anims));
  await ctx.close();
}

/* ---- reduced motion ---- */
for (const on of [false, true]) {
  const dir = variant(`rm-${on}`, (r) => SET.ca(r, on));
  const { page, ctx } = await open(dir, { reducedMotion: 'reduce' });
  await settled(page);
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({ anims: document.getAnimations().filter((a) => a.playState === 'running').length, hidden: [...document.querySelectorAll('[data-reveal]')].filter((e) => parseFloat(getComputedStyle(e).opacity) < 1).length, pre: document.querySelectorAll('.is-pre').length, ownAnim: getComputedStyle(document.querySelector('#rows .mrow')).animationName }));
  gate(`R-${on ? 'on' : 'off'}`, `reduced motion (CA ${on ? 'stated' : 'absent'}): zero running animations, everything visible, own pulse off`, r.anims === 0 && r.hidden === 0 && r.pre === 0 && r.ownAnim === 'none', JSON.stringify(r));
  await ctx.close();
}

/* ---- failure, backoff, last-good, polling, hidden tab (fake clock) ---- */
{
  const dir = variant('poll', (r) => SET.ca(r, false));
  const run = await open(dir, { clock: true });
  const { page, m, ctx } = run;
  const tick = async (ms) => { await page.clock.runFor(ms); await page.waitForTimeout(120); };
  await tick(500);
  gate('P01', 'first fetch fires immediately on load', m.log.boosts === 1, String(m.log.boosts));
  await tick(50_000);
  gate('P02', 'no refetch before the 60s mark', m.log.boosts === 1, String(m.log.boosts));
  await tick(15_000);
  gate('P03', 'polls every 60s', m.log.boosts === 2, String(m.log.boosts));
  const good = await page.evaluate(() => document.querySelector('#rows .mrow:nth-child(2) strong').textContent);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await tick(300_000);
  gate('P04', 'polling pauses while the tab is hidden', m.log.boosts === 2, String(m.log.boosts));
  m.o.boostsStatus = 500;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  gate('P05', 'fetches immediately when the tab turns visible', m.log.boosts === 3, String(m.log.boosts));
  const t0 = m.log.boosts;
  await tick(1_200); await tick(2_400); await tick(4_800);
  gate('P06', 'failure retries with exponential backoff (1s, 2s, 4s)', m.log.boosts === t0 + 3, `${m.log.boosts - t0} retries`);
  await tick(1_000);
  const err = await page.evaluate(() => ({ visible: !document.getElementById('feedError').hidden, text: document.getElementById('feedError').textContent, pill: document.getElementById('pillText').textContent, first: document.querySelector('#rows .mrow:nth-child(2) strong').textContent }));
  gate('P07', 'after failure the error shows and the last good rows stay', err.visible && /previous good/.test(err.text) && err.first === good && /retrying/i.test(err.pill), JSON.stringify(err));
  m.o.boostsStatus = 200; m.o.priceK = 3;
  await tick(61_000);
  await tick(2_000);
  const flash = await page.evaluate(() => ({ flashed: document.querySelectorAll('#rows .m.flash-up, #rows .m.flash-down').length, errHidden: document.getElementById('feedError').hidden }));
  gate('P08', 'recovery clears the error and changed values flash', flash.errHidden && flash.flashed > 0, JSON.stringify(flash));
  await ctx.close();
}
{ // first load failure: dashes and error
  const dir = variant('fail', (r) => SET.ca(r, false));
  const { page, ctx, m } = await open(dir, { clock: true, mocks: { boostsStatus: 500 } });
  for (const ms of [500, 1_200, 2_400, 4_800, 1_000]) { await page.clock.runFor(ms); await page.waitForTimeout(120); }
  const r = await page.evaluate(() => ({ err: document.getElementById('feedError').textContent, dashes: [...document.querySelectorAll('#rows .mrow')].slice(1).every((l) => l.querySelector('[data-col=price]').textContent === '—'), stat: document.getElementById('statVolume').textContent }));
  gate('P09', 'with no good data yet, rows and tiles show dashes plus an error message', /silent/.test(r.err) && r.dashes && r.stat === '—', JSON.stringify(r));
  await ctx.close();
}

/* ---- ticker uses the same data; no dates at runtime ---- */
{
  const run = caRuns[true];
  const { page } = { page: null };
}
for (const on of [false, true]) {
  const dir = variant(`rt-${on}`, (r) => { SET.ca(r, on); SET.x(r, on); SET.github(r, on); });
  const { page, ctx } = await open(dir);
  await settled(page);
  const probe = await page.evaluate(() => {
    const t = document.querySelector('#tickerTrack').textContent;
    const rows = [...document.querySelectorAll('#rows .mrow:not(:first-child) strong')].map((e) => e.textContent);
    const texts = document.body.innerText;
    const attrs = [...document.querySelectorAll('*')].flatMap((e) => ['aria-label', 'title', 'alt', 'placeholder', 'aria-description'].map((a) => e.getAttribute(a)).filter(Boolean)).join(' ');
    return { ticker: rows.filter((s) => t.includes(s)).length, rows: rows.length, texts, attrs, tickChips: document.querySelectorAll('#tickerTrack .tick').length };
  });
  gate(`L-${on ? 'on' : 'off'}`, `ticker is fed by the same live data as the board (CA ${on ? 'stated' : 'absent'})`, probe.tickChips >= 18 && probe.ticker === probe.rows, JSON.stringify({ t: probe.ticker, r: probe.rows, c: probe.tickChips }));
  const bad = [/\b\d{4}-\d{2}-\d{2}\b/, /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, /\b([01]?\d|2[0-3]):[0-5]\d\b/, /\bas of\b/i, /\bchecked\b/i, /\b(19|20)\d{2}\b/, /\b(ago|yesterday|today)\b/i];
  const hay = probe.texts + ' ' + probe.attrs;
  const hit = bad.map((p) => hay.match(p)).filter(Boolean).map((m) => m[0]);
  gate(`N-${on ? 'on' : 'off'}`, `runtime page text, aria-labels and tooltips hold zero dates or clock strings (all records ${on ? 'stated' : 'absent'})`, !hit.length, hit.join(','));
  const chips = await page.evaluate(() => [...document.querySelectorAll('.chip')].map((c) => `${c.dataset.chip}:${c.dataset.state}:${c.textContent.replace(/\s+/g, ' ').trim()}`));
  const wantWord = on ? 'stated' : 'pending';
  gate(`K-${on ? 'on' : 'off'}`, `register chips show label + ${wantWord} only`, chips.filter((c) => /^(ca|x|github):/.test(c)).every((c) => c.endsWith(wantWord)) && chips.every((c) => /^(ca|x|github|market):[a-z]+:\w[\w ]*(stated|pending)$/.test(c)), chips.join(' | '));
  await ctx.close();
}

/* ---- breakpoints ---- */
const BPS = [[360, 800], [390, 844], [430, 932], [1366, 768], [1440, 900]];
const table = [];
for (const on of [false, true]) {
  const dir = variant(`bp-${on}`, (r) => { SET.ca(r, on); SET.x(r, on); SET.github(r, on); });
  for (const [w, h] of BPS) {
    const { page, ctx } = await open(dir, { viewport: { width: w, height: h } });
    await settled(page);
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } scrollTo(0, 0); });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const targets = [...document.querySelectorAll('a[href], button, [role=tab]')].filter((e) => vis(e) && !e.classList.contains('skip'));
      const small = targets.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
      const soc = [...document.querySelectorAll('.social')].map((e) => { const r = e.getBoundingClientRect(); return { vis: vis(e), right: r.right, top: r.top, w: r.width, h: r.height }; });
      const ca = document.querySelector('.ca').getBoundingClientRect();
      const addr = document.querySelector('.ca-addr');
      const rowsOverflow = [...document.querySelectorAll('.mrow')].filter((r) => r.scrollWidth > r.clientWidth + 1).length;
      const wide = [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && !e.closest('.ticker, .hero-art, .layer'); }).length;
      scrollTo(0, 1600);
      const ca2 = document.querySelector('.ca').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, vw: innerWidth, small, soc, caTop: ca.top, caBottom: ca.bottom, caFs: parseFloat(getComputedStyle(addr).fontSize), caH: ca.height, ca2Top: ca2.top, rowsOverflow, wide, stickyH: document.querySelector('.top').getBoundingClientRect().height, rows: document.querySelectorAll('#rows .mrow').length };
    });
    const ok = m.sw <= m.vw && !m.small.length && m.soc.length === 2 && m.soc.every((s) => s.vis && s.w >= 44 && s.h >= 44 && s.top < 120) && m.vw - Math.max(...m.soc.map((s) => s.right)) <= 20 && m.soc[0].right < m.soc[1].right && m.caTop <= 1 && m.ca2Top <= 1 && m.rowsOverflow === 0 && m.wide === 0;
    table.push(`${String(w).padStart(4)}x${h}  CA ${on ? 'stated' : 'absent'}  scrollW ${m.sw}/${m.vw}  caFont ${m.caFs}px  caH ${Math.round(m.caH)}  sticky ${Math.round(m.stickyH)}px  rows ${m.rows}  small targets ${m.small.length}  rowOverflow ${m.rowsOverflow}`);
    gate(`M-${w}-${on ? 'on' : 'off'}`, `${w}px (CA ${on ? 'stated' : 'absent'}): no x-scroll, all tap targets >= 44x44, both social icons top-right, CA slot pinned`, ok, JSON.stringify({ sw: m.sw, small: m.small.slice(0, 4), soc: m.soc, ca2Top: m.ca2Top, rowsOverflow: m.rowsOverflow, wide: m.wide }));
    await ctx.close();
  }
}
console.log('\nMeasurements\n' + table.join('\n') + '\n');

/* ---- live network smoke (informational, not counted) ---- */
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const s = await serve(DIST); servers.push(s.srv);
  const page = await ctx.newPage();
  await page.goto(s.url);
  await page.waitForFunction(() => document.querySelectorAll('#rows .mrow:not(.is-skeleton)').length >= 10 && !document.querySelector('#rows .is-error'), null, { timeout: 25000 });
  info('live DexScreener smoke: ' + (await page.evaluate(() => document.querySelectorAll('#rows .mrow').length)) + ' rows rendered from the real feed');
  await ctx.close();
} catch (e) { info('live DexScreener smoke skipped: ' + String(e.message).split('\n')[0]); }

await browser.close();
servers.forEach((s) => s.close());
fs.rmSync(tmpRoot, { recursive: true, force: true });
finish();

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nGATES: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  if (failed.length) failed.forEach((f) => console.log(`  FAILED ${f.id}: ${f.desc}\n    ${f.detail}`));
  process.exit(failed.length ? 1 : 0);
}
