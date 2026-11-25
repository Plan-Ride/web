// Planner for the web client (same flow as the Android Planner tab), from emhub's timetables.
import { t, lang } from './i18n.js';
import { $, esc, apiJson, store, toast, clock, money, kindIcon, kindPlate } from './core.js';
import { readableStop, lineNumber, nextRideDeparture, localToEpoch, WORKDAYS, EVERY_DAY, plannerLeg, lineKind } from './logic.js';
import { openScheduledTrip, startJourney, isFollowed, cityRides } from './live.js';
import { parseTariffs, journeyCost, fareCategory, heldTicket } from './fares.js';
import { rides, saveRides, rideDayText } from './rides.js';
import { openSubmit } from './submit.js';

// One timetable for every region; the city is kept only because saved routes carry it.
const ALL = 'vlakbusmhd';
// Before 2.6 "Slovakia" was the intercity-only timetable; its stop ids differ, so saved stops are looked up again.
const upgrade = (r) => (r.city === 'slovensko' ? { ...r, city: ALL, fromSug: null, toSug: null } : r);
const SWAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>';

const p = {
  city: upgrade({ city: store.get('plannerCity', ALL) }).city, from: '', to: '', fromSug: null, toSug: null, time: '', date: '', direct: false, arrive: false,
  searchedRoute: null, // the route of the results on screen (the fields may have been edited since)
  results: [], cursor: null, loading: false, loadingMore: false, error: '', searched: false,
};
let root = null;
let onOpenStop = () => {};
let accounts = () => ({}); // { card, ids }: the signed-in accounts, for prices and credit warnings

// 2.18.0: which kinds of transport the planner may use (Bus, City, Train); the last one stays on.
const MODES = ['bus', 'city', 'rail'];
const modes = () => { const m = store.get('plannerModes', MODES).filter((x) => MODES.includes(x)); return m.length ? m : MODES; };

// 2.18.0: the carriers' price lists, kept a day.
let tariffs = parseTariffs(store.get('fares', null)?.json || {});
(async () => {
  const saved = store.get('fares', null);
  if (saved && Date.now() - saved.at < 86400000 && tariffs) return;
  const json = await apiJson('/api/hub/fares').catch(() => null);
  const parsed = json && parseTariffs(json);
  if (parsed) { tariffs = parsed; store.set('fares', { at: Date.now(), json }); if (root?.isConnected) renderBody(); }
})();

const routes = (key) => store.get(key, []).map(upgrade);
const sameRoute = (a, b) => a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase();

export function renderPlanner(el, { openStop, accounts: acc } = {}) {
  root = el;
  onOpenStop = openStop || onOpenStop;
  accounts = acc || accounts;
  if (p.date && p.date < todayIso()) p.date = '';
  const saved = routes('savedRoutes');
  const isSaved = p.from && p.to && saved.some((r) => sameRoute(r, { from: p.from.trim(), to: p.to.trim() }));
  el.innerHTML = `
    <header class="screen-head"><div><h1>${t('planner_title')}</h1><p class="hint small">${t('planner_sub')}</p></div></header>
    <form class="planner-form" autocomplete="off">
      <div class="od">
        <label class="od-field"><span>${t('from')}</span><input id="pl-from" value="${esc(p.from)}" required></label>
        <label class="od-field"><span>${t('to')}</span><input id="pl-to" value="${esc(p.to)}" required></label>
        <button type="button" class="icon-btn swap" data-swap aria-label="${esc(t('swap'))}">${SWAP}</button>
        <ul class="suggest" id="pl-suggest" role="listbox" hidden></ul>
      </div>
      <button type="button" class="chip" data-near>${t('nearest_stop')}</button>
      <div class="places">${['home', 'work'].map((k) => { const pl = store.get('place_' + k, null); return `<button type="button" class="place ${pl ? 'set' : ''}" data-place="${k}">
        <b>${t('place_' + k)}</b><span>${esc(pl ? placeName(pl) : t('place_not_set'))}</span></button>`; }).join('')}</div>
      <div class="planner-opts">
        <div class="segmented small"><button type="button" aria-pressed="${!p.time && !p.date}" data-now>${t('leave_now')}</button>
          <label class="time-pick ${p.time ? 'on' : ''}">${t(p.time && p.arrive ? 'arrive_at_time' : 'at_time')} <input type="time" id="pl-time" value="${esc(p.time)}"></label>
          <label class="time-pick ${p.date ? 'on' : ''}"><input type="date" id="pl-date" value="${esc(p.date)}" min="${todayIso()}" aria-label="${esc(t('date'))}"></label></div>
        ${p.time ? `<label class="mini-switch"><input type="checkbox" id="pl-arrive" ${p.arrive ? 'checked' : ''}> ${t('arrive_by')}</label>` : ''}
        <label class="mini-switch"><input type="checkbox" id="pl-car" ${store.get('catchCar', false) ? 'checked' : ''}> ${t('to_stop_by_car')}</label>
        <label class="mini-switch"><input type="checkbox" id="pl-direct" ${p.direct ? 'checked' : ''}> ${t('direct_only')}</label>
      </div>
      <div class="chips modes" role="group">${MODES.map((m) => `<button type="button" class="chip mode ${modes().includes(m) ? 'on' : ''}" data-mode="${m}" aria-pressed="${modes().includes(m)}">${kindIcon(m === 'city' ? 'tram' : m, 18)} ${t('kind_' + m)}</button>`).join('')}</div>
      <div class="planner-actions">
        <button class="btn" type="submit" ${p.loading ? 'disabled' : ''}>${p.loading ? '<span class="spinner"></span>' : t('search')}</button>
        <button class="icon-btn star ${isSaved ? 'on' : ''}" type="button" data-save aria-pressed="${!!isSaved}" aria-label="${esc(t(isSaved ? 'unsave_route' : 'save_route'))}" ${p.from && p.to ? '' : 'disabled'}>★</button>
      </div>
    </form>
    <div id="pl-body"></div>`;
  bind(el);
  renderBody();
}

function renderBody() {
  const box = $('#pl-body', root);
  if (!box) return;
  if (p.error) { box.innerHTML = `<div class="notice error">${esc(p.error)}</div>`; return; }
  const missing = `<button class="btn outline wide" data-missing>${t('submit_missing_connection')}</button>`;
  if (p.results.length) {
    box.innerHTML = `${p.rainy ? `<div class="notice">${t('planner_rain')}</div>` : ''}<ul class="connections">${p.results.map(connectionHtml).join('')}</ul>
      ${p.cursor ? `<button class="btn outline wide" data-more ${p.loadingMore ? 'disabled' : ''}>${p.loadingMore ? '<span class="spinner"></span>' : t('load_more')}</button>` : ''}${missing}`;
    return;
  }
  if (p.searched && !p.loading) { box.innerHTML = `<div class="empty"><p>${t('no_connections')}</p>${missing}</div>`; return; }
  const chips = (list, key) => list.map((r, i) => `<button class="chip route" data-route="${key}:${i}">${esc(readableStop(r.from))} – ${esc(readableStop(r.to))}</button>`).join('');
  const saved = routes('savedRoutes'), recent = routes('recentRoutes');
  box.innerHTML = (saved.length ? `<h2 class="section-label">${t('saved_routes')}</h2><div class="chips">${chips(saved, 'savedRoutes')}</div>` : '') +
    (recent.length ? `<h2 class="section-label">${t('recent')}</h2><div class="chips">${chips(recent, 'recentRoutes')}</div>` : '') + ridesListHtml();
}

function connectionHtml(c, ci) {
  // 2.17.0: how often the change onto this bus worked on earlier days (late when under 80 %).
  const odds = (s) => (s.transfer?.runs ? `<p class="small transfer-odds ${s.transfer.worked * 5 >= s.transfer.runs * 4 ? '' : 'late'}">${esc(t('transfer_odds', s.transfer.worked, s.transfer.runs))}</p>` : '');
  const segs = c.segments.map((s, si) => `
    <li class="seg">${si ? odds(s) : ''}
      <div class="seg-line">${kindPlate(s.line, lineKind(s.line, s.group, s.vehicle))}<span class="hint small">${esc(s.operatorName)}</span></div>
      <div class="seg-stops">
        <button class="seg-stop" data-stop="${ci}:${si}:dep"><b>${esc(s.departureTime)}</b> ${esc(readableStop(s.departureStop))}${s.departurePlatform ? ` <span class="pf">${esc(t('platform', s.departurePlatform))}</span>` : ''}</button>
        <button class="seg-stop" data-stop="${ci}:${si}:arr"><b>${esc(s.arrivalTime)}</b> ${esc(readableStop(s.arrivalStop))}${s.arrivalPlatform ? ` <span class="pf">${esc(t('platform', s.arrivalPlatform))}</span>` : ''}</button>
      </div>
      ${s.goesOnAs?.length ? `<p class="small goes-on">${esc(t('planner_goes_on_as', s.goesOnAs.map(([line]) => line).join(' › ')))}</p>` : ''}
      ${s.routeUrl ? `<button class="text-btn" data-trip="${ci}:${si}">${t('show_stops')}</button>` : ''}
    </li>`).join('');
  const saved = savedJourneys().some((j) => sameJourney(j.connection, c));
  const kinds = [...new Set(c.segments.map((s) => lineKind(s.line, s.group, s.vehicle)))].slice(0, 3);
  const fare = fareNote(c);
  const walk = (w) => (w ? `<p class="walk-row small">${esc(t('walk_to', w.minutes, readableStop(w.stop)))}<span>${esc(w.arrivalTime)}</span></p>` : '');
  // EM-0116: a followed journey says so, in its own colour.
  const legs = c.segments.filter((s) => s.routeUrl);
  const followed = legs.length > 1 && isFollowed(plannerLeg(legs[0]).ref);
  return `<li class="connection">
    <div class="conn-head"><span class="conn-kinds">${kinds.map((k) => kindIcon(k, 26)).join('')}</span>
      <span class="conn-main"><span class="conn-times">${esc(c.departureTime)} – ${esc(c.arrivalTime)}</span>
        <span class="hint">${esc([c.totalDuration, fare.price].filter(Boolean).join('  ·  '))}</span></span>
      <button class="icon-btn star ${saved ? 'on' : ''}" data-save-journey="${ci}" aria-pressed="${saved}" aria-label="${esc(t(saved ? 'unsave_journey' : 'save_journey'))}">★</button>
      <button class="icon-btn" data-repeat="${ci}" aria-label="${esc(t('rides_repeat'))}">↻</button>
      <button class="icon-btn" data-share="${ci}" aria-label="${esc(t('share'))}">⤴</button></div>
    ${fare.warning ? `<div class="notice warn small">${esc(fare.warning)}</div>` : ''}
    ${walk(c.walkBefore)}<ol class="segs">${segs}</ol>${walk(c.walkAfter)}
    ${legs.length > 1 ? (followed ? `<button class="btn wide tonal" disabled>${t('journey_following')}</button>` : `<button class="btn wide soft" data-journey="${ci}">${t('journey_follow')}</button>`) : ''}</li>`;
}

const shareText = (c) => `${c.departureTime} – ${c.arrivalTime} (${c.totalDuration})\n` +
  c.segments.map((s) => `${s.line}: ${s.departureTime} ${readableStop(s.departureStop)} → ${s.arrivalTime} ${readableStop(s.arrivalStop)}`).join('\n');

function bind(el) {
  const from = $('#pl-from', el), to = $('#pl-to', el), sug = $('#pl-suggest', el);
  let active = null, timer = null;
  const suggest = (input, which) => {
    p[which] = input.value;
    p[which + 'Sug'] = null;
    clearTimeout(timer);
    if (input.value.trim().length < 2) { sug.hidden = true; return; }
    timer = setTimeout(async () => {
      const list = await apiJson(`/api/cp/suggest?city=${p.city}&q=${encodeURIComponent(input.value)}`).catch(() => []);
      if (document.activeElement !== input) return;
      active = { input, which, list };
      sug.innerHTML = list.map((s, i) => `<li role="option"><button type="button" data-sug="${i}">${esc(s.text)}${s.town ? `<small>${esc(t('town_whole'))}</small>` : s.description ? `<small>${esc(s.description)}</small>` : ''}</button></li>`).join('');
      sug.dataset.which = which;
      sug.hidden = !list.length;
    }, 250);
  };
  from.oninput = () => suggest(from, 'from');
  to.oninput = () => suggest(to, 'to');
  sug.onpointerdown = (e) => e.preventDefault(); // keep focus so the tap lands
  sug.onclick = (e) => {
    const b = e.target.closest('[data-sug]');
    if (!b || !active) return;
    const s = active.list[Number(b.dataset.sug)];
    active.input.value = s.text;
    p[active.which] = s.text;
    p[active.which + 'Sug'] = s;
    sug.hidden = true;
    (active.which === 'from' ? to : null)?.focus();
    askAhead();
  };
  [from, to].forEach((i) => (i.onblur = () => setTimeout(() => (sug.hidden = true), 150)));
  // EM-0070: iOS reports every turn of the time and date wheels as a change while the picker is open; redrawing the form
  // then closed it mid-scroll. A change only keeps the value; the form is redrawn once the time picker is closed, and only
  // when "arrive by" has to appear or go.
  const hadTime = !!p.time;
  const pick = (input, value) => {
    input.closest('.time-pick').classList.toggle('on', !!value);
    $('[data-now]', el).setAttribute('aria-pressed', String(!p.time && !p.date));
  };
  $('#pl-time', el).onchange = (e) => { p.time = e.target.value; pick(e.target, p.time); };
  $('#pl-time', el).onblur = () => { if (!!p.time !== hadTime) renderPlanner(root); };
  $('#pl-date', el).onchange = (e) => { p.date = e.target.value === todayIso() ? '' : e.target.value; pick(e.target, p.date); };
  $('#pl-direct', el).onchange = (e) => (p.direct = e.target.checked);
  // EM-0074: on foot or by car to the stop (catch estimates), right in the planner too.
  $('#pl-car', el).onchange = (e) => store.set('catchCar', e.target.checked);
  const arrive = $('#pl-arrive', el);
  if (arrive) arrive.onchange = (e) => { p.arrive = e.target.checked; renderPlanner(root); };
  $('form', el).onsubmit = (e) => { e.preventDefault(); search(); };
  // Hold (a long press is a context menu on phones) or right-click a place: set it from To.
  // EM-0108: it opens a stop search to choose the place (it took whatever To had, unseen).
  el.querySelectorAll('[data-place]').forEach((b) => (b.oncontextmenu = (e) => { e.preventDefault(); pickPlace(b.dataset.place); }));
  el.onclick = (e) => {
    if (e.target.closest('[data-swap]')) {
      [p.from, p.to, p.fromSug, p.toSug] = [p.to, p.from, p.toSug, p.fromSug];
      // EM-0129: the results were still the old direction's under the swapped stops: search the new one at once.
      if (p.results.length || p.searched) return search();
      askAhead();
      return renderPlanner(root);
    }
    if (e.target.closest('[data-now]')) { p.time = ''; p.date = ''; return renderPlanner(root); }
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      const m = mode.dataset.mode, now = modes();
      const next = now.includes(m) ? now.filter((x) => x !== m) : [...now, m];
      if (!next.length) return;
      store.set('plannerModes', next);
      if (p.results.length || p.searched) return search();
      askAhead();
      return renderPlanner(root);
    }
    if (e.target.closest('[data-missing]')) return openSubmit('trip', { from: p.fromSug, to: p.toSug });
    const place = e.target.closest('[data-place]');
    if (place) return goPlace(place.dataset.place);
    if (e.target.closest('[data-near]')) {
      if (!navigator.geolocation) return toast(t('no_stop_near'));
      return navigator.geolocation.getCurrentPosition(async (pos) => {
        const s = await apiJson(`/api/cp/nearest?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`).catch(() => null);
        if (!s) return toast(t('no_stop_near'));
        p.from = s.text;
        p.fromSug = s;
        renderPlanner(root);
      }, () => toast(t('no_stop_near')), { maximumAge: 60000, timeout: 15000 });
    }
    const sj = e.target.closest('[data-save-journey]');
    if (sj) { toggleJourney(p.results[Number(sj.dataset.saveJourney)]); return renderBody(); }
    const rep = e.target.closest('[data-repeat]');
    if (rep) return editRide(rideFrom(p.results[Number(rep.dataset.repeat)]), true);
    const rideRow = e.target.closest('[data-ride]');
    if (rideRow) return editRide(rides().find((r) => r.id === rideRow.dataset.ride), false);
    if (e.target.closest('[data-save]')) return toggleSaved();
    if (e.target.closest('[data-more]')) return more();
    const route = e.target.closest('[data-route]');
    if (route) {
      const [key, i] = route.dataset.route.split(':');
      const r = routes(key)[Number(i)];
      Object.assign(p, { city: r.city || p.city, from: r.from, to: r.to, fromSug: r.fromSug || null, toSug: r.toSug || null });
      return search();
    }
    const share = e.target.closest('[data-share]');
    if (share) {
      const text = shareText(p.results[Number(share.dataset.share)]);
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else navigator.clipboard?.writeText(text).then(() => toast(t('copied')));
      return;
    }
    const journey = e.target.closest('[data-journey]');
    if (journey) {
      // Every bus of the connection, one after another: get-off alert, then the next bus.
      const legs = p.results[Number(journey.dataset.journey)].segments.filter((s) => s.routeUrl)
        .map(plannerLeg);
      startJourney(legs);
      toast(t('journey_started'));
      return renderBody();
    }
    const trip = e.target.closest('[data-trip]');
    if (trip) {
      const [ci, si] = trip.dataset.trip.split(':').map(Number);
      return openScheduledTrip(p.results[ci].segments[si]);
    }
    const stop = e.target.closest('[data-stop]');
    if (stop) {
      const [ci, si, end] = stop.dataset.stop.split(':');
      const s = p.results[Number(ci)].segments[Number(si)];
      onOpenStop(end === 'dep' ? s.departureStop : s.arrivalStop, { line: lineNumber(s.line), time: end === 'dep' ? s.departureTime : '' });
    }
  };
}

/**
 * 2.17.0 "Take me home": Home or Work from the stop nearest you, now. Not set yet: the stop picked in To becomes it
 * (hold the button, or right-click, to set it again from To; with To empty it's forgotten).
 */
function goPlace(kind) {
  const pl = store.get('place_' + kind, null);
  if (!pl) return pickPlace(kind);
  Object.assign(p, { to: pl.text, toSug: pl, time: '', date: '', arrive: false });
  if (!navigator.geolocation) return renderPlanner(root);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const s = await apiJson(`/api/cp/nearest?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`).catch(() => null);
    if (!s) { toast(t('place_no_location')); return renderPlanner(root); }
    Object.assign(p, { from: s.text, fromSug: s });
    search();
  }, () => { toast(t('place_no_location')); renderPlanner(root); }, { maximumAge: 60000, timeout: 15000 });
}
/** EM-0108: the stop itself, not the town every place starts with ("Banská Bystrica, …"). */
const placeName = (pl) => { const i = pl.text.indexOf(', '); return i >= 0 ? pl.text.slice(i + 2) : pl.text; };

/** EM-0108: Home or Work chosen by searching for its stop (the whole name shown), or forgotten. */
function pickPlace(kind) {
  const name = t('place_' + kind), current = store.get('place_' + kind, null);
  const d = document.createElement('div');
  d.className = 'dialog-backdrop';
  d.innerHTML = `<div class="dialog stack" role="dialog" aria-modal="true" aria-labelledby="place-title">
    <h2 id="place-title">${esc(t('place_pick_title', name))}</h2>
    ${current ? `<p class="hint small">${esc(t('place_pick_now', current.text))}</p>` : ''}
    <label class="field">${t('place_pick_search')}<input id="place-q" autocomplete="off"></label>
    <ul class="list" id="place-list"></ul>
    <div class="dialog-actions">${current ? `<button type="button" class="text-btn danger" data-clear>${t('place_pick_clear')}</button>` : ''}
      <button type="button" class="text-btn" data-cancel>${t('cancel')}</button></div></div>`;
  let found = [], timer = null;
  const done = (pl) => {
    store.set('place_' + kind, pl);
    toast(pl ? t('place_saved', name, placeName(pl)) : t('place_cleared', name));
    d.remove();
    renderPlanner(root);
  };
  $('#place-q', d).oninput = (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#place-list', d).innerHTML = ''; return; }
    timer = setTimeout(async () => {
      found = await apiJson(`/api/cp/suggest?q=${encodeURIComponent(q)}`).catch(() => []);
      $('#place-list', d).innerHTML = found.map((s, i) => `<li><button type="button" class="row link" data-pick="${i}"><span class="row-text"><span class="row-title">${esc(s.text)}</span></span></button></li>`).join('');
    }, 300);
  };
  d.onclick = (e) => {
    if (e.target === d || e.target.closest('[data-cancel]')) return d.remove();
    if (e.target.closest('[data-clear]')) return done(null);
    const pick = e.target.closest('[data-pick]');
    if (pick) done(found[Number(pick.dataset.pick)]);
  };
  document.body.appendChild(d);
  $('#place-q', d).focus();
}

function toggleSaved() {
  const r = { city: p.city, from: p.from.trim(), to: p.to.trim(), fromSug: p.fromSug, toSug: p.toSug };
  const saved = routes('savedRoutes');
  store.set('savedRoutes', saved.some((x) => sameRoute(x, r)) ? saved.filter((x) => !sameRoute(x, r)) : [r, ...saved].slice(0, 20));
  renderPlanner(root);
}

/** What a search asks the server, also when asked ahead. */
const query = () => ({
  city: p.city, from: p.from.trim(), to: p.to.trim(), fromSug: p.fromSug, toSug: p.toSug, time: p.time, date: cpDate(p.date), directOnly: p.direct,
  arriveBy: p.arrive && !!p.time, modes: modes().join(','), walkOther: store.get('walkOther', false),
});

/** 2.18.0: once both stops are chosen the server is asked right away, so Search shows the answer it already has. */
function askAhead() {
  if (p.fromSug && p.toSug && p.from.trim() && p.to.trim()) apiJson('/api/cp/search', query()).catch(() => {});
}

/**
 * 2.18.0: { price, warning } of a connection with the transport cards: the price in the rider's category (from the
 * accounts), a warning when a credit won't cover it. Buses paid by bank card (Reminders settings) give no warning.
 */
function fareNote(c) {
  if (!tariffs) return {};
  const { card, ids } = accounts() || {};
  const now = Date.now();
  const ms = (v) => (!v ? 0 : v < 1e12 ? v * 1000 : v);
  const passes = (ids?.tickets || []).filter((x) => x.valid && x.validToMs > now);
  const cityPass = ms(card?.ticketValidTo) > now;
  const category = fareCategory([card?.cardTypeName || '', ...(ids?.tickets || []).map((x) => x.name)]);
  // ponytail: any valid IDS BBSK season ticket counts as covering the regional buses (a Sieťovka does; a Časovka
  // only its zones), and a valid SAD Zvolen one as covering both cities. Same as the Android app.
  // EM-0110: a city bus ridden a little earlier (followed here) makes the next one cost its change.
  const cost = journeyCost(tariffs, c.segments, category, cityPass, passes.length > 0, heldTicket(tariffs, cityRides(), now));
  const total = cost.sadzvCents + cost.idsCents;
  let price = total === 0 && cost.covered ? t('fare_covered') : total === 0 ? '' : cost.unknown ? t('fare_from', money(total / 100)) : money(total / 100);
  if (price && cost.train) price = t('fare_plus_train', price);
  const short = (name, credit, cents, bank) => (!bank && credit != null && cents > Math.round(credit * 100)
    ? t('fare_short', name, money(credit), money(cents / 100)) : '');
  const warning = [short('SAD Zvolen', card?.creditLastBalance ?? null, cost.sadzvCents, store.get('bankCardCity', false)),
    short('IDS BBSK', ids?.credit ?? null, cost.idsCents, store.get('bankCardRegion', false))].filter(Boolean).join('\n');
  return { price, warning };
}

async function search() {
  if (!p.from.trim() || !p.to.trim()) return;
  Object.assign(p, { loading: true, error: '', results: [], cursor: null, searched: true });
  renderPlanner(root);
  try {
    const r = await apiJson('/api/cp/search', {
      ...query(),
    });
    Object.assign(p, { results: r.connections, cursor: r.cursor, fromSug: r.from, toSug: r.to, rainy: !!r.rainy });
    p.searchedRoute = { city: p.city, from: r.from.text, to: r.to.text, fromSug: r.from, toSug: r.to };
    const recent = { city: p.city, from: r.from.text, to: r.to.text, fromSug: r.from, toSug: r.to };
    store.set('recentRoutes', [recent, ...routes('recentRoutes').filter((x) => !sameRoute(x, recent))].slice(0, 8));
  } catch {
    p.error = t('planner_failed');
  }
  p.loading = false;
  renderPlanner(root);
}

async function more() {
  p.loadingMore = true;
  renderBody();
  try {
    const r = await apiJson('/api/cp/more', { cursor: p.cursor });
    const ids = new Set(p.results.map((c) => c.id));
    const key = (c) => `${c.segments[0].serviceDate} ${c.segments[0].departureTime.padStart(5, '0')}`;
    p.results = [...p.results, ...r.connections.filter((c) => !ids.has(c.id))].sort((a, b) => key(a).localeCompare(key(b)));
    p.cursor = r.cursor;
  } catch {
    toast(t('planner_failed'));
  }
  p.loadingMore = false;
  renderBody();
}

// ---------------------------------------------------------------- date

const todayIso = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava' }).format(new Date());
/** The server takes "3.10.2026"; "" means today. */
const cpDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().map(Number).join('.') : '');

/** Opens the planner on a route at a time and date and searches (a saved journey from the home tab). */
export function searchAt(route, time, date, el) {
  Object.assign(p, { city: route.city || p.city, from: route.from, to: route.to, fromSug: route.fromSug || null, toSug: route.toSug || null, time: time || '', date: date && date !== todayIso() ? date : '' });
  root = el || root;
  search();
}

// ---------------------------------------------------------------- saved journeys (shown on the home tab)

export const savedJourneys = () => store.get('savedJourneys', []);
const sameJourney = (a, b) => JSON.stringify(a.segments.map((s) => [s.line, s.departureTime, s.serviceDate])) === JSON.stringify(b.segments.map((s) => [s.line, s.departureTime, s.serviceDate]));
const epoch = (iso, time) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''), m = /(\d{1,2}):(\d{2})/.exec(time || '');
  return d && m ? localToEpoch(+d[1], +d[2], +d[3], +m[1], +m[2]) : 0;
};
/** When the journey ends (0 = unknown); the date rolls over when the clock goes backwards. */
export function journeyTimes(j) {
  const first = j.connection.segments[0], last = j.connection.segments.at(-1);
  const dep = epoch(first.serviceDate, first.departureTime);
  let arr = epoch(last.serviceDate, last.arrivalTime);
  if (arr && arr < epoch(last.serviceDate, last.departureTime)) arr += 86400000;
  return { dep, arr };
}
function toggleJourney(c) {
  const list = savedJourneys();
  if (list.some((j) => sameJourney(j.connection, c))) store.set('savedJourneys', list.filter((j) => !sameJourney(j.connection, c)));
  else {
    const route = p.searchedRoute || { city: p.city, from: p.from, to: p.to, fromSug: p.fromSug, toSug: p.toSug };
    const now = Date.now();
    const kept = list.filter((j) => { const { arr } = journeyTimes(j); return !arr || arr > now; }); // ended ones are of no use
    store.set('savedJourneys', [...kept, { id: String(now), route, connection: c }].sort((a, b) => journeyTimes(a).dep - journeyTimes(b).dep).slice(-20));
    toast(t('journey_saved'));
  }
}
export function removeJourney(id) { store.set('savedJourneys', savedJourneys().filter((j) => j.id !== id)); }

// ---------------------------------------------------------------- regular rides

/** A ride from a planner result, prefilled for the editor: same stops, time and lines, workdays. */
function rideFrom(c) {
  const m = /(\d{1,2}):(\d{2})/.exec(c.segments[0].departureTime);
  return {
    id: String(Date.now()), route: p.searchedRoute || { city: p.city, from: p.from, to: p.to, fromSug: p.fromSug, toSug: p.toSug },
    time: `${m[1].padStart(2, '0')}:${m[2]}`, lines: c.segments.map((s) => lineNumber(s.line)),
    days: WORKDAYS, dates: [], startDate: null, endDate: null, leadMinutes: 10, enabled: true,
  };
}

const dayName = (iso) => new Date(Date.UTC(2024, 0, iso)).toLocaleDateString(lang() === 'en' ? 'en-GB' : 'sk-SK', { weekday: 'short', timeZone: 'UTC' }); // 2024-01-01 was a Monday
const daysText = (r) => {
  const d = [...r.days].sort().join();
  if (d === EVERY_DAY.join()) return t('rides_every_day');
  if (d === WORKDAYS.join()) return t('rides_workdays');
  if (d === '6,7') return t('rides_weekends');
  if (!r.days.length) return t('rides_dates_only');
  return [...r.days].sort().map(dayName).join(' ');
};
const rideLabel = (r) => `${readableStop(r.route.from)} → ${readableStop(r.route.to)}`;

function ridesListHtml() {
  const list = rides();
  return `<h2 class="section-label">${t('rides_title')}</h2>` + (list.length
    ? `<ul class="list">${list.map((r) => {
      const next = nextRideDeparture(r);
      return `<li><button class="row link" data-ride="${esc(r.id)}"><span class="row-text"><span class="row-title">${esc(rideLabel(r))}</span>
        <span class="row-sub">${esc(r.time)} · ${esc(daysText(r))}<br>${next ? esc(t('rides_next', rideDayText(next), clock(next))) : esc(t(r.enabled ? 'rides_no_next' : 'rides_paused'))}</span></span><span aria-hidden="true">›</span></button></li>`;
    }).join('')}</ul>`
    : `<p class="hint pad">${t('rides_empty')}</p>`);
}

/** Time, days, a date range, extra dates and how early following starts. */
function editRide(ride, isNew) {
  if (!ride) return;
  let r = { ...ride, days: [...ride.days], dates: [...ride.dates] };
  const d = document.createElement('div');
  d.className = 'dialog-backdrop';
  const draw = () => {
    d.innerHTML = `<form class="dialog stack ride-editor" role="dialog" aria-modal="true" aria-labelledby="ride-title">
      <h2 id="ride-title">${esc(rideLabel(r))}</h2>
      <p class="hint small">${t('rides_intro')}</p>
      ${r.lines.length ? `<p class="small">${esc(t('rides_lines', r.lines.join(' → ')))}</p>` : ''}
      <label class="field">${t('rides_departs')}<input type="time" name="time" value="${esc(r.time)}" required></label>
      <fieldset class="chips"><legend class="section-label">${t('rides_days')}</legend>
        ${r.days.length || r.dates.length ? '' : `<p class="hint small">${t('rides_pick_days')}</p>`}
        ${EVERY_DAY.map((n) => `<label class="chip"><input type="checkbox" name="day" value="${n}" ${r.days.includes(n) ? 'checked' : ''}>${esc(dayName(n))}</label>`).join('')}</fieldset>
      <div class="chips"><button type="button" class="chip" data-days="1,2,3,4,5">${t('rides_workdays')}</button><button type="button" class="chip" data-days="6,7">${t('rides_weekends')}</button><button type="button" class="chip" data-days="1,2,3,4,5,6,7">${t('rides_every_day')}</button></div>
      <div class="two"><label class="field">${t('rides_from')}<input type="date" name="startDate" value="${esc(r.startDate || '')}"></label>
        <label class="field">${t('rides_until')}<input type="date" name="endDate" value="${esc(r.endDate || '')}"></label></div>
      <fieldset class="chips"><legend class="section-label">${t('rides_dates')}</legend>
        ${r.dates.sort().map((x) => `<button type="button" class="chip" data-drop-date="${x}">${esc(x.split('-').reverse().join('.'))} ✕</button>`).join('')}
      </fieldset>
      <label class="field">${t('rides_add_date')}<input type="date" name="addDate"></label>
      <label class="field">${t('rides_lead')}<select name="lead">${[5, 10, 15, 20, 30, 45].map((m) => `<option value="${m}" ${r.leadMinutes === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
      <ul class="list"><li><label class="row switch-row"><span class="row-title">${t('rides_enabled')}</span><input type="checkbox" role="switch" name="enabled" ${r.enabled ? 'checked' : ''}></label></li></ul>
      <p class="hint small">${t('rides_web_hint')}</p>
      <p class="error-text" id="ride-error" hidden></p>
      <div class="dialog-actions">${isNew ? '' : `<button type="button" class="text-btn danger" data-delete>${t('rides_delete')}</button>`}
        <button type="button" class="text-btn" data-cancel>${t('cancel')}</button><button class="btn" type="submit">${t('save')}</button></div></form>`;
  };
  const read = () => {
    const f = $('form', d);
    r = { ...r, time: f.time.value || r.time, days: [...f.querySelectorAll('[name=day]:checked')].map((x) => Number(x.value)),
      startDate: f.startDate.value || null, endDate: f.endDate.value || null, leadMinutes: Number(f.lead.value), enabled: f.enabled.checked };
  };
  draw();
  d.onchange = (e) => {
    read();
    if (e.target.name === 'addDate' && e.target.value && !r.dates.includes(e.target.value)) { r.dates.push(e.target.value); draw(); }
    if (e.target.name === 'day') draw(); // the "no day: just today" hint comes and goes with the last day
  };
  d.onclick = async (e) => {
    if (e.target === d || e.target.closest('[data-cancel]')) return d.remove();
    const days = e.target.closest('[data-days]');
    if (days) { read(); r.days = days.dataset.days.split(',').map(Number); return draw(); }
    const drop = e.target.closest('[data-drop-date]');
    if (drop) { read(); r.dates = r.dates.filter((x) => x !== drop.dataset.dropDate); return draw(); }
    if (e.target.closest('[data-delete]')) { await saveRides(rides().filter((x) => x.id !== r.id)); d.remove(); return renderBody(); }
  };
  d.onsubmit = async (e) => {
    e.preventDefault();
    read();
    const err = $('#ride-error', d);
    // EM-0076: no day picked: just today, or tomorrow when its time (minus the lead) has already gone.
    if (!r.days.length && !r.dates.length) {
      const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
      const [h, m] = r.time.split(':').map(Number), [nh, nm] = now.split(':').map(Number);
      const today = todayIso();
      const tomorrow = new Date(Date.UTC(...today.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) + 86400000).toISOString().slice(0, 10);
      r.dates = [h * 60 + m - r.leadMinutes > nh * 60 + nm ? today : tomorrow];
    }
    const ok = await saveRides([...rides().filter((x) => x.id !== r.id), r]);
    if (!ok) { err.textContent = t('rides_push_needed'); err.hidden = false; return; }
    d.remove();
    renderBody();
  };
  document.body.appendChild(d);
}
