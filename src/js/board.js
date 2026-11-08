// Market board DOM. Row 1 is the own-token row. Rows 2-10 are trending.
import { ICONS, esc } from './register-view.js';
import { setNumber } from './fx.js';
import { fmtUsd, fmtPrice, fmtChange } from './market.js';

const PLACEHOLDER_DOTS = '· · · · ·';
const FALLBACK_LOGO = 'assets/logo-192.png';
const BRAND_LOGO = 'assets/cycle-logo.png';

function makeRow() {
  const li = document.createElement('li');
  li.className = 'mrow spot';
  li.innerHTML =
    '<span class="c-rank"></span>' +
    '<div class="c-id"><span class="logo"></span><div class="id-text"><strong></strong><small></small></div></div>' +
    '<div class="metrics">' +
    '<span class="m" data-col="price" data-label="Price"></span>' +
    '<span class="m" data-col="change" data-label="24h"></span>' +
    '<span class="m" data-col="vol" data-label="Volume"></span>' +
    '<span class="m" data-col="liq" data-label="Liquidity"></span>' +
    '</div>' +
    `<button class="copy" type="button" aria-label="Copy token address" title="Copy address">${ICONS.copy}</button>`;
  return li;
}

function skeletonRow(i, own) {
  const li = document.createElement('li');
  li.className = 'mrow is-skeleton' + (own ? ' own' : '');
  li.style.setProperty('--i', i);
  li.innerHTML =
    `<span class="c-rank">${i + 1}</span>` +
    '<div class="c-id"><span class="logo sk"></span><div class="id-text"><span class="sk sk-line"></span><span class="sk sk-line short"></span></div></div>' +
    '<div class="metrics"><span class="m sk sk-line"></span><span class="m sk sk-line"></span><span class="m sk sk-line"></span><span class="m sk sk-line"></span></div>' +
    '<span></span>';
  return li;
}

function setLogo(logo, { src, fallback, letter, tileOk }) {
  const key = `${src || ''}|${fallback || ''}`;
  if (logo.dataset.key === key) return;
  logo.dataset.key = key;
  logo.textContent = '';
  const tile = () => {
    logo.textContent = '';
    const t = document.createElement('span');
    t.className = 'tile';
    t.textContent = (letter || '?').slice(0, 1).toUpperCase();
    t.dataset.tile = '1';
    logo.appendChild(t);
  };
  if (!src && !fallback) { tile(); return; }
  const img = new Image();
  img.alt = '';
  img.width = 44; img.height = 44;
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => {
    if (fallback && !img.src.endsWith(fallback)) { img.src = fallback; return; }
    if (tileOk) tile(); else img.removeAttribute('src');
  };
  img.src = src || fallback;
  logo.appendChild(img);
}

export function createBoard({ rowsEl, onCopy }) {
  const live = new Map(); // key -> li
  let lastKeys = '';
  let skeletons = true;
  let first = true;

  function paintRow(li, rank, d) {
    li.querySelector('.c-rank').textContent = String(rank);
    li.querySelector('strong').textContent = d.symbol;
    li.querySelector('small').textContent = d.sub;
    setLogo(li.querySelector('.logo'), d.logo);
    const cells = {
      price: li.querySelector('[data-col="price"]'),
      change: li.querySelector('[data-col="change"]'),
      vol: li.querySelector('[data-col="vol"]'),
      liq: li.querySelector('[data-col="liq"]')
    };
    if (d.placeholder) {
      cells.price.textContent = '$0.00';
      cells.change.textContent = PLACEHOLDER_DOTS;
      cells.vol.textContent = PLACEHOLDER_DOTS;
      cells.liq.textContent = PLACEHOLDER_DOTS;
    } else {
      setNumber(cells.price, d.price, fmtPrice);
      setNumber(cells.change, d.change, fmtChange);
      setNumber(cells.vol, d.volume, fmtUsd);
      setNumber(cells.liq, d.liquidity, fmtUsd);
      cells.change.classList.toggle('up', Number.isFinite(d.change) && d.change >= 0);
      cells.change.classList.toggle('down', Number.isFinite(d.change) && d.change < 0);
      cells.liq.title = d.liquidityLabel === 'Mkt Cap' ? 'Mkt Cap' : '';
      cells.liq.dataset.label = d.liquidityLabel === 'Mkt Cap' ? 'Mkt Cap' : 'Liquidity';
    }
    const btn = li.querySelector('.copy');
    btn.disabled = !d.address;
    btn.dataset.copy = d.address || '';
    li.classList.toggle('own', !!d.own);
    li.classList.toggle('is-placeholder', !!d.placeholder);
    if (d.placeholder) { li.setAttribute('aria-disabled', 'true'); } else { li.removeAttribute('aria-disabled'); }
    li.dataset.key = d.key;
    li.classList.toggle('is-error', !!d.error);
  }

  rowsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.copy');
    if (b && !b.disabled && b.dataset.copy) onCopy(b.dataset.copy, b);
  });

  // model: { own: null | {...}, caStated, rows: [...] (already deduped, sorted, length <= 9), loading, error }
  function render(model) {
    const list = [];
    if (!model.caStated) {
      list.push({ key: 'own', own: true, placeholder: true, symbol: 'CYCLE', sub: 'pending', logo: { src: BRAND_LOGO, fallback: FALLBACK_LOGO, tileOk: false }, address: '' });
    } else if (model.own) {
      const o = model.own;
      list.push({ key: 'own', own: true, symbol: o.symbol || 'CYCLE', sub: o.found ? (o.name || '') : 'no pair yet', address: o.address,
        logo: { src: o.img, fallback: FALLBACK_LOGO, letter: 'C', tileOk: false },
        price: o.price, change: o.change, volume: o.volume, liquidity: o.liquidity, liquidityLabel: o.liquidityLabel, error: model.ownError });
    } else {
      list.push({ key: 'own', own: true, skeleton: true });
    }

    if (model.rows) {
      model.rows.forEach((r) => list.push({ key: r.address, symbol: r.symbol, sub: r.name, address: r.address,
        logo: { src: r.img, fallback: null, letter: r.symbol, tileOk: true }, price: r.price, change: r.change, volume: r.volume, liquidity: r.liquidity, liquidityLabel: 'Liquidity' }));
    } else if (model.error) {
      for (let i = 0; i < 9; i++) list.push({ key: 'err' + i, symbol: '—', sub: 'feed silent', address: '', error: true, price: NaN, change: NaN, volume: NaN, liquidity: NaN, logo: { tileOk: true, letter: '—' } });
    } else {
      for (let i = 0; i < 9; i++) list.push({ key: 'sk' + i, skeleton: true });
    }

    const keys = list.map((d) => d.key + (d.skeleton ? ':s' : '')).join('|');
    if (keys === lastKeys) {
      list.forEach((d, i) => { const li = live.get(d.key); if (li && !d.skeleton) paintRow(li, i + 1, d); });
      return;
    }
    lastKeys = keys;
    const keep = new Set();
    const frag = [];
    list.forEach((d, i) => {
      let li = live.get(d.key);
      if (d.skeleton) {
        if (!li || !li.classList.contains('is-skeleton')) { li = skeletonRow(i, d.key === 'own'); live.set(d.key, li); }
        keep.add(d.key); frag.push(li); return;
      }
      if (!li || li.classList.contains('is-skeleton')) {
        if (li) li.remove();
        li = makeRow();
        li.style.setProperty('--i', i);
        li.classList.add('is-pre');
        live.set(d.key, li);
        requestAnimationFrame(() => requestAnimationFrame(() => li.classList.remove('is-pre')));
      } else {
        li.style.setProperty('--i', i);
      }
      paintRow(li, i + 1, d);
      keep.add(d.key); frag.push(li);
    });
    for (const [k, li] of live) if (!keep.has(k)) { li.remove(); live.delete(k); }
    frag.forEach((li, i) => { if (rowsEl.children[i] !== li) rowsEl.insertBefore(li, rowsEl.children[i] || null); });
    skeletons = false; first = false;
  }

  function replay() {
    [...rowsEl.children].forEach((li, i) => {
      if (i === 0 || li.classList.contains('is-skeleton')) return;
      li.style.transition = 'none';
      li.classList.add('is-pre');
      void li.offsetWidth;
      li.style.transition = '';
      requestAnimationFrame(() => requestAnimationFrame(() => li.classList.remove('is-pre')));
    });
  }

  return { render, replay };
}

export { esc };
