// Shared helpers for the web client: DOM, storage, API, formatting, sheets, logs.
import { t, lang } from './i18n.js';

export const VERSION = '2.18.6';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ app log (for bug reports)
const logLines = [];
export function log(level, ...parts) {
  const line = `${new Date().toISOString()} ${level} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  logLines.push(line.slice(0, 2000));
  if (logLines.length > 400) logLines.shift();
}
addEventListener('error', (e) => log('E', 'uncaught', e.error || e.message));
addEventListener('unhandledrejection', (e) => log('E', 'unhandled rejection', e.reason));
export const collectLogs = () =>
  `Plan&Ride web ${VERSION}\n${navigator.userAgent}\nlanguage ${lang()}, standalone ${matchMedia('(display-mode: standalone)').matches || navigator.standalone === true}\n\n` +
  logLines.join('\n').replace(/("?(password|pin|sessionId)"?\s*[:=]\s*)"?[^",\s]+"?/gi, '$1[removed]');

// ------------------------------------------------------------------ storage (always safe)
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('testem.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { value == null ? localStorage.removeItem('testem.' + key) : localStorage.setItem('testem.' + key, JSON.stringify(value)); } catch { /* full or blocked */ }
  },
};

// ------------------------------------------------------------------ API
export async function api(path, body, { method } = {}) {
  let res;
  try {
    res = await fetch(path, body === undefined && !method
      ? {}
      : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  } catch (err) {
    log('W', 'network', path, err.message);
    return { ok: false, status: 0, json: { error: 'offline' } };
  }
  let json = {};
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) log('W', path, res.status, json.error || '');
  return { ok: res.ok, status: res.status, json };
}
/** Like api() but returns the JSON or throws with the server's message. */
export async function apiJson(path, body, opts) {
  const r = await api(path, body, opts);
  if (!r.ok) throw Object.assign(new Error(r.json.error || `HTTP ${r.status}`), { status: r.status });
  return r.json;
}

export const config = { hub: false, hubWs: '', vapidPublicKey: '' };
export async function loadConfig() {
  const r = await api('/api/config');
  if (r.ok) Object.assign(config, r.json);
}

// ------------------------------------------------------------------ formatting
const locale = () => (lang() === 'en' ? 'en-GB' : 'sk-SK');
// Slovak buses run on Slovak time, also on a phone set to another time zone.
export const clock = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bratislava' });
export const dateText = (ms) => new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Bratislava' });
export const money = (v, cur = '€') => `${Number(v).toFixed(2).replace('.', lang() === 'en' ? '.' : ',')} ${cur || '€'}`;
export function countdown(seconds) {
  const m = Math.round(seconds / 60);
  if (m <= 0) return t('countdown_now');
  if (m < 60) return t('countdown_min', m);
  return t('countdown_h', Math.floor(m / 60), m % 60);
}
export function delayInfo(seconds) {
  if (seconds == null) return null;
  const m = Math.round(seconds / 60);
  if (m >= 1) return { text: t('delay_late', m), cls: m >= 5 ? 'late very' : 'late' };
  if (m <= -1) return { text: t('delay_early', -m), cls: 'early' };
  return { text: t('delay_on_time'), cls: 'ontime' };
}
export const delayChip = (seconds) => {
  const d = delayInfo(seconds);
  return d ? `<span class="delay ${d.cls}">${esc(d.text)}</span>` : '';
};
export const plate = (line, extra = '') => `<span class="plate ${extra}">${esc(line)}</span>`;
// 2.18.0: what carries you at a glance: a pictogram and a plate in the kind's colour (buses the app's colour,
// trains dark, city lines purple), as in the Android app. Material icons, no emoji.
const KIND_PATHS = {
  bus: 'M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM18 11H6V6h12v5Z',
  rail: 'M4 15.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V5c0-3.5-3.58-4-8-4s-8 .5-8 4v10.5zm8 1.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm6-7H6V5h12v5z',
  tram: 'M19 16.94V8.5c0-2.79-2.61-3.4-6.01-3.49l.76-1.51H17V2H7v1.5h4.75l-.76 1.52C7.86 5.11 5 5.73 5 8.5v8.44c0 1.45 1.19 2.66 2.59 2.97L6 21.5v.5h2.23l2-2H14l2 2h2v-.5L16.5 20h-.08c1.69 0 2.58-1.37 2.58-3.06zm-7 1.56c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm5-4.5H7V9h10v5z',
};
export const kindIcon = (kind, size = 24) =>
  `<svg class="kind-icon k-${kind}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${KIND_PATHS[kind === 'rail' ? 'rail' : kind === 'tram' ? 'tram' : 'bus']}"/></svg>`;
export const kindPlate = (line, kind, extra = '') =>
  plate(kind === 'rail' ? String(line || '').trim() : String(line || '').trim().split(' ').at(-1) || '–', `k-${kind} ${extra}`);
/** Account timestamps are seconds or ms. */
export const toMs = (v) => (!v ? 0 : v < 1e12 ? v * 1000 : v);

// ------------------------------------------------------------------ toast
export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3500);
}

// ------------------------------------------------------------------ sheets & pages
/**
 * Bottom sheet (trip details) or full page (settings). Returns the body element.
 * Only one of each at a time; closing runs onClose.
 */
function overlay(id, cls, title, onClose) {
  closeOverlay(id);
  const el = document.createElement('div');
  el.id = id;
  el.className = cls;
  el.innerHTML = `<div class="${cls}-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${cls === 'sheet' ? '<div class="sheet-grab" aria-hidden="true"></div>' : ''}
      <header class="${cls}-head"><button class="icon-btn" data-close aria-label="${esc(t(cls === 'page' ? 'back' : 'close'))}">${cls === 'page' ? '‹' : '✕'}</button><h2>${esc(title)}</h2></header>
      <div class="${cls}-body"></div></div>`;
  el._onClose = onClose;
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) closeOverlay(id); });
  document.body.appendChild(el);
  $('[data-close]', el).focus({ preventScroll: true });
  // Touch screens only: with a mouse the sheet stays as it was (opens tall, its content scrolls with the wheel).
  if (cls === 'sheet' && matchMedia('(pointer: coarse)').matches) dragSheet(el, id);
  return $(`.${cls}-body`, el);
}

/**
 * EM-0123: the sheet behaves like Android's. It opens at about half the screen; dragging it up (by its top, or by its
 * content while that can't scroll yet) opens it fully, dragging it down closes it or brings it back to half. Inside,
 * the content scrolls only once the sheet is fully open; at the top of the content, pulling down moves the sheet again.
 */
function dragSheet(el, id) {
  const panel = $('.sheet-panel', el), body = $('.sheet-body', el);
  const half = () => innerHeight * 0.55, full = () => innerHeight * 0.92;
  let open = 'half', start = null;
  const setMax = (px, settle) => {
    panel.classList.toggle('settling', settle);
    panel.style.maxHeight = `${px}px`;
  };
  setMax(half(), false);
  body.style.overflowY = 'hidden';
  const snap = (to) => {
    open = to;
    setMax(to === 'full' ? full() : half(), true);
    body.style.overflowY = to === 'full' ? 'auto' : 'hidden';
    if (to === 'half') body.scrollTop = 0; // EM-0124: half open, its top (the Follow button) shows
  };
  panel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const onBody = body.contains(e.target);
    // Fully open with scrolled content: the content scrolls as usual.
    if (onBody && open === 'full' && body.scrollTop > 0) { start = null; return; }
    start = { y: e.touches[0].clientY, h: panel.getBoundingClientRect().height, onBody, moved: false, t: Date.now() };
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dy = e.touches[0].clientY - start.y;
    // Fully open, on the content, pulling up: that's a scroll, not a drag.
    if (start.onBody && open === 'full' && dy < 0 && !start.moved) { start = null; return; }
    if (!start.moved && Math.abs(dy) < 6) return;
    start.moved = true;
    e.preventDefault();
    panel.classList.remove('settling');
    const h = Math.min(full(), start.h - dy);
    panel.style.maxHeight = `${Math.max(0, h)}px`;
    panel.style.height = `${Math.max(0, h)}px`;
  }, { passive: false });
  panel.addEventListener('touchend', (e) => {
    if (!start?.moved) { start = null; return; }
    const dy = e.changedTouches[0].clientY - start.y, speed = dy / Math.max(1, Date.now() - start.t); // px per ms, + down
    const h = start.h - dy;
    start = null;
    panel.style.height = '';
    if (speed > 0.6 || h < half() * 0.6) {
      // Down and away: it slides off, then closes.
      panel.classList.add('settling', 'leaving');
      setTimeout(() => closeOverlay(id), 220);
    } else snap(speed < -0.4 || h > (half() + full()) / 2 ? 'full' : 'half');
  });
}
export const openSheet = (title, onClose) => overlay('sheet', 'sheet', title, onClose);
export const openPage = (title, onClose) => overlay('page', 'page', title, onClose);
export function closeOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.remove();
  el._onClose?.();
}
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('sheet')) closeOverlay('sheet');
  else closeOverlay('page');
});

export const switchRow = (id, title, hint, checked, disabled = false) => `
  <label class="row switch-row"><span class="row-text"><span class="row-title">${esc(title)}</span>${hint ? `<span class="row-sub">${esc(hint)}</span>` : ''}</span>
  <input type="checkbox" role="switch" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;

/** A photo for a bug report or a submission (EM-0120): at most 1600 px on the longer side, JPEG, as base64 (a phone photo is ~200 kB then). */
export async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.8));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
