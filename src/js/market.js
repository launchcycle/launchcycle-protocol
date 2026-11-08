// Data layer. Trending follows the market register record only. Own token follows the CA record only.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { timeout = 10000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Exponential backoff: base, 2x, 4x ... capped, with a little jitter.
export async function withBackoff(fn, { tries = 4, base = 1000, cap = 8000 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (i < tries - 1) await sleep(Math.min(cap, base * 2 ** i) * (0.85 + Math.random() * 0.3));
    }
  }
  throw err;
}

const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };

function shape(pair) {
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol || '?',
    name: pair.baseToken.name || '',
    img: (pair.info && pair.info.imageUrl) || null,
    price: num(pair.priceUsd),
    change: num(pair.priceChange && pair.priceChange.h24),
    volume: num(pair.volume && pair.volume.h24),
    liquidity: num(pair.liquidity && pair.liquidity.usd)
  };
}

export async function fetchTrending(rec) {
  const boosts = await withBackoff(() => fetchJson(rec.url));
  if (!Array.isArray(boosts)) throw new Error('shape');
  const seen = new Set();
  const addrs = [];
  for (const b of boosts) {
    if (b && b.chainId === 'solana' && b.tokenAddress && !seen.has(b.tokenAddress)) { seen.add(b.tokenAddress); addrs.push(b.tokenAddress); }
  }
  if (!addrs.length) throw new Error('empty');
  const chunks = [];
  for (let i = 0; i < addrs.length && i < 60; i += 30) chunks.push(addrs.slice(i, i + 30));
  const results = await Promise.all(chunks.map((c) => withBackoff(() => fetchJson(rec.pairs + c.join(',')))));
  const best = new Map();
  for (const p of results.flat()) {
    if (!p || !p.baseToken || !seen.has(p.baseToken.address)) continue;
    const cur = best.get(p.baseToken.address);
    if ((num(p.volume && p.volume.h24) || 0) > ((cur && num(cur.volume && cur.volume.h24)) || -1)) best.set(p.baseToken.address, p);
  }
  const rows = [...best.values()].map(shape).sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 10);
  if (!rows.length) throw new Error('empty');
  return rows;
}

export async function fetchOwn(rec, ca) {
  const safe = (p) => p.then((v) => ({ ok: true, v }), () => ({ ok: false, v: null }));
  const [dex, pump] = await Promise.all([
    safe(withBackoff(() => fetchJson(rec.ownPair + ca))),
    safe(fetchJson(rec.ownMeta + ca))
  ]);
  console.log('[cycle] own token raw response', { dex: dex.v, pump: pump.v });
  if (!dex.ok) throw new Error('own pair feed');
  const pairs = ((dex.v && dex.v.pairs) || [])
    .filter((p) => p.baseToken && p.baseToken.address === ca)
    .sort((a, b) => (num(b.volume && b.volume.h24) || 0) - (num(a.volume && a.volume.h24) || 0));
  const pair = pairs[0] || null;
  const cands = { liquidityUsd: pair && pair.liquidity ? pair.liquidity.usd : null, marketCap: pair ? pair.marketCap : null, fdv: pair ? pair.fdv : null };
  console.log('[cycle] own liquidity candidates', cands);
  const liq = num(cands.liquidityUsd);
  const mc = num(cands.marketCap);
  return {
    found: !!pair,
    address: ca,
    symbol: pair ? pair.baseToken.symbol : null,
    name: pair ? pair.baseToken.name : null,
    img: pump.v && pump.v.image_uri ? pump.v.image_uri : null,
    price: pair ? num(pair.priceUsd) : null,
    change: pair ? num(pair.priceChange && pair.priceChange.h24) : null,
    volume: pair ? num(pair.volume && pair.volume.h24) : null,
    liquidity: liq && liq > 0 ? liq : mc,
    liquidityLabel: liq && liq > 0 ? 'Liquidity' : 'Mkt Cap'
  };
}

export const fmtUsd = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(2);
};
export const fmtPrice = (p) => {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1) return '$' + p.toFixed(p >= 100 ? 2 : 4);
  if (p === 0) return '$0.00';
  const digits = Math.min(10, Math.max(4, 2 - Math.floor(Math.log10(p))));
  return '$' + p.toFixed(digits);
};
export const fmtChange = (c) => {
  if (!Number.isFinite(c)) return '—';
  const body = Math.abs(c) >= 1000 ? Math.abs(c).toLocaleString('en-US', { maximumFractionDigits: 0 }) : Math.abs(c).toFixed(2);
  return (c >= 0 ? '▲ ' : '▼ ') + body + '%';
};
export const fmtInt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—');
