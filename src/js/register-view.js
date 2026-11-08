// Pure string renderers shared by the build (prerender) and the browser (runtime render).
// Every function reads the record it is given; nothing here hardcodes a record state.

export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isAddress(s) {
  return typeof s === 'string' && ADDRESS_RE.test(s);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Stated means the record carries the fact. Anything else renders inert.
export function isStated(rec) {
  return !!rec && rec.state === 'stated';
}

// Store the URL, derive the handle. Returns '' when the URL has no usable path.
export function deriveHandle(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? seg : u.hostname;
  } catch {
    return '';
  }
}

export const ICONS = {
  x: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>',
  github: '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>'
};

export function renderCaSlot(rec) {
  const stated = isStated(rec) && isAddress(rec.value);
  const label = '<span class="ca-label">Contract</span>';
  if (!stated) {
    return `<div class="ca-inner" data-ca-state="${esc(rec ? rec.state : 'absent')}">${label}<span class="ca-value is-inert" aria-disabled="true"><span class="ca-addr">pending</span></span></div>`;
  }
  const a = esc(rec.value);
  return `<div class="ca-inner" data-ca-state="stated">${label}<button class="ca-value" type="button" data-copy="${a}" aria-label="Copy contract address"><span class="ca-addr">${a}</span><span class="ca-hint" data-hint aria-live="polite">Copy</span></button></div>`;
}

const SOCIAL_NAME = { x: 'X', github: 'GitHub' };

export function renderSocial(key, rec) {
  const name = SOCIAL_NAME[key];
  if (isStated(rec) && rec.url) {
    const handle = deriveHandle(rec.url);
    return `<a class="social" data-social="${key}" data-state="stated" href="${esc(rec.url)}" target="_blank" rel="noopener noreferrer" aria-label="${name}${handle ? ' ' + esc(handle) : ''}">${ICONS[key]}</a>`;
  }
  return `<button class="social is-inert" type="button" data-social="${key}" data-state="${esc(rec ? rec.state : 'absent')}" disabled aria-label="${name}, pending">${ICONS[key]}</button>`;
}

export function renderSocials(reg) {
  return renderSocial('x', reg.records.x) + renderSocial('github', reg.records.github);
}

// Inert records show label and the word pending. Nothing else.
export function renderChips(reg) {
  return ['ca', 'x', 'github', 'market']
    .map((k) => {
      const r = reg.records[k];
      const word = isStated(r) ? 'stated' : 'pending';
      return `<li class="chip spot" data-chip="${k}" data-state="${esc(r.state)}"><span class="chip-label">${esc(r.label)}</span><span class="chip-state">${word}</span></li>`;
    })
    .join('');
}
