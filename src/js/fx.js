// Motion helpers. Every entry point checks reduced motion and falls back to instant.

export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Damped spring solved with fixed sub-steps (semi-implicit Euler).
export function spring(from, to, onUpdate, onDone, cfg = {}) {
  const { stiffness = 170, damping = 15, mass = 1, precision = 0.002 } = cfg;
  let x = from, v = 0, last = performance.now(), raf = 0, dead = false;
  const tick = (now) => {
    if (dead) return;
    const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
    last = now;
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (-stiffness * (x - to) - damping * v) / mass;
      v += a * h;
      x += v * h;
    }
    onUpdate(x);
    if (Math.abs(x - to) < precision && Math.abs(v) < precision) { onUpdate(to); if (onDone) onDone(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { dead = true; cancelAnimationFrame(raf); };
}

// Scroll reveal with a stagger inside each batch and a spring on opacity and lift.
export function initReveal() {
  const els = [...document.querySelectorAll('[data-reveal]')];
  const settle = (el) => { el.style.opacity = ''; el.style.transform = ''; el.classList.add('is-in'); };
  if (reduced() || !('IntersectionObserver' in window)) { els.forEach(settle); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (!e.isIntersecting && e.boundingClientRect.bottom <= 0) { io.unobserve(e.target); settle(e.target); } // scrolled past before it could play
    const batch = entries.filter((e) => e.isIntersecting);
    batch.forEach((entry, i) => {
      const el = entry.target;
      io.unobserve(el);
      setTimeout(() => {
        spring(0, 1, (p) => { el.style.opacity = String(Math.min(1, Math.max(0, p))); el.style.transform = `translateY(${(1 - p) * 24}px)`; }, () => settle(el));
      }, i * 70);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -4% 0px' });
  els.forEach((el) => io.observe(el));
  // Safety net: anything still hidden after a while is shown.
  setTimeout(() => els.forEach((el) => { if (!el.classList.contains('is-in') && el.getBoundingClientRect().top < innerHeight) settle(el); }), 5000);
}

export function initParallax() {
  const art = document.querySelector('.hero-art');
  if (!art || reduced()) return;
  const layers = [...art.querySelectorAll('[data-depth]')];
  let tx = 0, ty = 0, cx = 0, cy = 0, visible = true, raf = 0;
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible && !raf) raf = requestAnimationFrame(loop); }).observe(art);
  window.addEventListener('pointermove', (e) => {
    const r = art.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / innerWidth * 2));
    ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / innerHeight * 2));
  }, { passive: true });
  function loop() {
    raf = 0;
    if (!visible) return;
    cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
    const sy = Math.max(0, Math.min(1, scrollY / 600));
    for (const l of layers) {
      const d = parseFloat(l.dataset.depth) || 0;
      l.style.transform = `translate3d(${(cx * d * 14).toFixed(2)}px, ${(cy * d * 14 - sy * d * 26).toFixed(2)}px, 0)`;
    }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
}

export function initSpotlight() {
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('.spot');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

export function initProgress() {
  const bar = document.getElementById('progress');
  if (!bar) return;
  let queued = false;
  const paint = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(paint); } }, { passive: true });
  addEventListener('resize', paint);
  paint();
}

// Count a number toward its target. Flashes on a change after the first paint.
export function setNumber(el, value, fmt) {
  const ok = typeof value === 'number' && Number.isFinite(value);
  const prev = el._v;
  if (el._stop) { el._stop(); el._stop = null; }
  if (!ok) { el.textContent = '—'; el._v = undefined; return; }
  el._v = value;
  if (reduced()) { el.textContent = fmt(value); return; }
  const from = typeof prev === 'number' ? prev : 0;
  if (from === value) { el.textContent = fmt(value); return; }
  if (typeof prev === 'number') {
    const cls = value > prev ? 'flash-up' : 'flash-down';
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(cls);
  }
  const t0 = performance.now(), dur = 700;
  let raf = 0;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (value - from) * e);
    if (k < 1) raf = requestAnimationFrame(step); else el.textContent = fmt(value);
  };
  raf = requestAnimationFrame(step);
  el._stop = () => cancelAnimationFrame(raf);
}
