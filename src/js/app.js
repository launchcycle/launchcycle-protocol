import { renderCaSlot, renderSocials, renderChips, isStated, isAddress, esc } from './register-view.js';
import { fetchJson, fetchTrending, fetchOwn, fmtUsd, fmtPrice, fmtChange, fmtInt } from './market.js';
import { createBoard } from './board.js';
import { initReveal, initParallax, initSpotlight, initProgress, setNumber, reduced } from './fx.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 60000;

let reg = null;
let ca = null;
let trending = null;       // last good trending rows
let trendingError = false;
let own = null;            // last good own row
let ownError = false;
let status = 'loading';
let sort = 'volume';
let timer = 0;
let inflight = false;

/* ---------- register driven chrome ---------- */
function paintRegister() {
  const r = reg.records;
  $('ca').innerHTML = renderCaSlot(r.ca);
  $('socials').innerHTML = renderSocials(reg);
  $('chips').innerHTML = renderChips(reg);
  ca = isStated(r.ca) && isAddress(r.ca.value) ? r.ca.value : null;
}

/* ---------- copy with feedback ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
let live;
function announce(msg) {
  if (!live) {
    live = document.createElement('div');
    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    document.body.appendChild(live);
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}
async function onCopy(text, btn) {
  const ok = await copyText(text);
  btn.classList.add('is-copied');
  const hint = btn.querySelector('[data-hint]');
  const prevHint = hint ? hint.textContent : '';
  const prevTitle = btn.title;
  if (hint) hint.textContent = ok ? 'Copied' : 'Press Ctrl C';
  btn.title = ok ? 'Copied' : 'Copy refused';
  announce(ok ? 'Address copied' : 'Copy refused');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.classList.remove('is-copied');
    if (hint) hint.textContent = prevHint || 'Copy';
    btn.title = prevTitle;
  }, 1600);
}

/* ---------- model ---------- */
function displayed() {
  if (!trending) return null;
  const pool = trending.filter((x) => x.address !== ca).slice(0, 9);
  const key = { volume: 'volume', change: 'change', liquidity: 'liquidity' }[sort];
  return pool.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
}

const board = createBoard({ rowsEl: $('rows'), onCopy });

function paint() {
  const rows = displayed();
  board.render({ caStated: !!ca, own, ownError, rows, error: trendingError && !trending });

  const err = $('feedError');
  if (trendingError) {
    err.hidden = false;
    err.textContent = trending ? 'Feed silent. Holding the previous good board.' : 'Feed silent. Rows stay as dashes till it speaks.';
  } else if (ca && ownError) {
    err.hidden = false;
    err.textContent = 'Own row stalled. Holding its previous values.';
  } else err.hidden = true;

  const chain = reg && isStated(reg.records.chain) ? reg.records.chain.value : '';
  const pill = $('pillText');
  pill.textContent = status === 'error' ? 'Feed retrying' : status === 'loading' ? 'Syncing feed' : (chain ? `Live on ${chain}` : 'Live');
  pill.previousElementSibling.classList.toggle('is-warn', status === 'error');

  // stats come only from rows that carry live data
  const data = [];
  if (rows) data.push(...rows);
  if (ca && own && own.found) data.push(own);
  const vol = data.reduce((s, r) => s + (r.volume || 0), 0);
  const dep = data.reduce((s, r) => s + (r.liquidity || 0), 0);
  let mover = null;
  for (const r of data) if (Number.isFinite(r.change) && (!mover || r.change > mover.change)) mover = r;
  const has = data.length > 0;
  setNumber($('statCount'), has ? data.length : NaN, fmtInt);
  setNumber($('statVolume'), has ? vol : NaN, fmtUsd);
  setNumber($('statDepth'), has ? dep : NaN, fmtUsd);
  setNumber($('statMover'), mover ? mover.change : NaN, fmtChange);
  setNumber($('heroVolume'), has ? vol : NaN, fmtUsd);
  setNumber($('heroMover'), mover ? mover.change : NaN, fmtChange);
  $('heroMoverSub').textContent = mover ? mover.symbol : (trendingError ? 'feed silent' : 'standing by');

  paintTicker(rows, data);
}

function paintTicker(rows, data) {
  const track = $('tickerTrack');
  const src = [];
  if (ca && own && own.found) src.push(own);
  if (trending) src.push(...trending.filter((x) => x.address !== ca));
  if (!src.length) return;
  const items = src.map((r) => {
    const up = Number.isFinite(r.change) && r.change >= 0;
    return `<span class="tick"><b>${esc(r.symbol)}</b><span>${esc(fmtPrice(r.price))}</span><span class="${up ? 'up' : 'down'}">${esc(fmtChange(r.change))}</span></span>`;
  }).join('');
  const anim = track.getAnimations ? track.getAnimations()[0] : null;
  const t = anim ? anim.currentTime : null;
  track.innerHTML = `<div class="tick-group">${items}</div><div class="tick-group" aria-hidden="true">${items}</div>`;
  const a2 = track.getAnimations ? track.getAnimations()[0] : null;
  if (a2 && t != null) a2.currentTime = t;
}

/* ---------- polling ---------- */
async function refresh() {
  const market = reg.records.market;
  if (!isStated(market)) { trendingError = true; status = 'error'; paint(); return; }
  const jobs = [fetchTrending(market).then((r) => ({ ok: true, r }), () => ({ ok: false }))];
  if (ca) jobs.push(fetchOwn(market, ca).then((r) => ({ ok: true, r }), () => ({ ok: false })));
  const [t, o] = await Promise.all(jobs);
  if (t.ok) { trending = t.r; trendingError = false; } else trendingError = true;
  if (ca && o) { if (o.ok) { own = o.r; ownError = false; } else ownError = true; }
  status = trendingError ? 'error' : 'live';
  paint();
}

async function cycle() {
  if (inflight) return;
  inflight = true;
  clearTimeout(timer);
  try { await refresh(); } finally { inflight = false; schedule(); }
}
function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(cycle, POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else cycle();
});

/* ---------- tabs ---------- */
function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    sort = tab.dataset.sort;
    document.querySelectorAll('.tab').forEach((t) => { const on = t === tab; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', String(on)); });
    paint();
    if (!reduced()) board.replay();
  }));
}

/* ---------- boot ---------- */
async function boot() {
  initProgress(); initSpotlight(); initParallax(); initReveal(); wireTabs();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.ca-value[data-copy]');
    if (b) onCopy(b.dataset.copy, b);
  });
  for (let i = 0; i < 3 && !reg; i++) {
    try { reg = await fetchJson('register.json', { timeout: 10000 }); } catch (e) { console.warn('[cycle] register fetch retry', i + 1); await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  const fromFile = !!(reg && reg.records);
  if (!fromFile) {
    reg = { records: { chain: { state: 'absent', label: 'Chain' }, ca: { state: 'absent', label: 'Contract' }, x: { state: 'absent', label: 'X' }, github: { state: 'absent', label: 'GitHub' }, market: { state: 'absent', label: 'Market feed' } } };
  }
  paintRegister();
  document.documentElement.dataset.register = fromFile ? 'ready' : 'fallback';
  paint();
  cycle();
}
boot();
