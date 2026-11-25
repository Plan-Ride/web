// 2.18.0: what a journey costs with the transport cards and whether the credit covers it, as in the Android app
// (Fares.kt). The prices are the carriers' own price lists kept in emHUB (GET /api/hub/fares); each planner leg says
// which tariff it goes by. Amounts in cents, the card price (what the credit pays).
import { walletForLine, localToEpoch } from './logic.js';

/** emHUB's price lists as { id: tariff }, or null. */
export function parseTariffs(json) {
  const card = (v) => (Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : null); // [card, cash]
  try {
    return Object.fromEntries(json.tariffs.map((t) => [t.id, t.kind === 'flat'
      ? { id: t.id, name: t.name || '', flat: true, transferMinutes: t.transferMinutes || 0, transferCents: t.transferCents || 0,
        prices: Object.fromEntries(Object.entries(t.prices || {}).map(([k, v]) => [k, card(v)])) }
      : { id: t.id, flat: false, columns: t.as || {}, special: card(t.special),
        bands: (t.bands || []).map((b) => [b.upTo, card(b.full), card(b.discount)]) }]));
  } catch { return null; }
}

function price(t, category, units = null) {
  if (t.flat) return t.prices[category] ?? t.prices.full ?? null;
  if (t.columns[category] === 'special') return t.special;
  if (units == null) return null;
  const band = t.bands.find((b) => units <= b[0]);
  return band ? (t.columns[category] === 'discount' ? band[2] : band[1]) : null;
}

/**
 * The rider's category from what the accounts call it: the card's type at SAD Zvolen ("Žiak/Študent do 26 rokov")
 * or an IDS BBSK ticket's name ("Zľavnené cestovné, žiak a študent 18-26 r., IDS Sieťovka 365 dní").
 */
export function fareCategory(texts) {
  const t = texts.join(' ').toLowerCase();
  if (t.includes('sprievod')) return 'companion';
  if (t.includes('ťzp') || t.includes('tzp') || t.includes('zdravotn')) return 'ztp';
  if (t.includes('jansk') || t.includes('darc')) return 'donor';
  if (['žiak', 'ziak', 'študent', 'student'].some((w) => t.includes(w))) return 'student';
  if (['dieťa', 'deti', 'mladistv'].some((w) => t.includes(w))) return 'child';
  if (['senior', 'dôchod', 'dochod'].some((w) => t.includes(w))) return 'senior';
  return 'full';
}

const minuteOfDay = (clock) => { const [h, m] = String(clock || '').split(':').map((x) => parseInt(x, 10) || 0); return h * 60 + m; };

/**
 * What [segments] cost: { sadzvCents, idsCents, unknown, train, covered }. cityPass / regionPass: a valid season
 * ticket covers the city buses / the IDS BBSK buses. City buses: a card ticket lasts transferMinutes and a change
 * within it costs transferCents (Zvolen: nothing; Banská Bystrica: 0,10 € for the first change, then a new ticket).
 */
export function journeyCost(tariffs, segments, category, cityPass, regionPass, held = null) {
  let carried = held; // EM-0110: a city ticket from before the journey (heldTicket)
  let sadzv = 0, ids = 0, unknown = false, train = false, covered = false;
  let ticket = null; // { id, since, used }
  let units = 0, region = null;
  const closeRegion = () => {
    if (!region) return;
    // ponytail: the units of the legs added up stand in for the units from the first stop to the last (the same
    // along one road, a little more on a detour); exact needs the zones of the whole ride from emHUB.
    const p = price(region, category, units);
    if (p == null) unknown = true; else ids += p;
    region = null;
    units = 0;
  };
  for (const s of segments) {
    if (s.group === 'rail') { closeRegion(); train = true; continue; } // train fares aren't in emHUB's price lists
    const tariff = s.tariff ? tariffs[s.tariff] : null;
    // SAD Zvolen's long-distance lines (not 060xxx) aren't IDS BBSK, whatever emHUB guessed from the operator.
    const cityOperator = /^MHD (Banská Bystrica|Zvolen)/.test(s.operatorName || '');
    if (!tariff || (!tariff.flat && (cityOperator || walletForLine(s.line) !== 'ids'))) { closeRegion(); unknown = true; continue; }
    if (!tariff.flat) {
      if (regionPass) { covered = true; continue; }
      if (tariff.columns[category] !== 'special' && s.units == null) unknown = true;
      if (region && region.id !== tariff.id) closeRegion();
      region = tariff;
      units += s.units ?? 0;
      continue;
    }
    closeRegion();
    if (cityPass) { covered = true; continue; }
    const at = minuteOfDay(s.departureTime);
    // EM-0110: the first city bus of the journey may ride on the ticket bought before it (within its time).
    const leaves = epochOf(s);
    const fromBefore = carried && !ticket && carried.tariffId === tariff.id && tariff.transferMinutes > 0 && leaves != null
      && leaves - carried.boughtMs >= 0 && leaves - carried.boughtMs <= tariff.transferMinutes * 60000 && (tariff.transferCents === 0 || !carried.changed);
    if (carried) {
      const c = carried;
      carried = null;
      if (fromBefore) {
        sadzv += tariff.transferCents;
        const bought = new Date(c.boughtMs);
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(bought);
        const part = (k) => Number(parts.find((x) => x.type === k)?.value || 0);
        ticket = { id: tariff.id, since: part('hour') * 60 + part('minute'), used: tariff.transferCents > 0 };
        continue;
      }
    }
    const held = ticket && ticket.id === tariff.id && tariff.transferMinutes > 0 && (at - ticket.since + 1440) % 1440 <= tariff.transferMinutes
      && (tariff.transferCents === 0 || !ticket.used);
    if (held) { sadzv += tariff.transferCents; ticket.used = true; } else {
      const p = price(tariff, category);
      if (p == null) unknown = true; else sadzv += p;
      ticket = { id: tariff.id, since: at, used: false };
    }
  }
  closeRegion();
  return { sadzvCents: sadzv, idsCents: ids, unknown, train, covered };
}

/** When a leg leaves (its date and time in Slovakia), null if either is missing. */
function epochOf(s) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.serviceDate || '');
  if (!d) return null;
  const m = minuteOfDay(s.departureTime);
  return localToEpoch(+d[1], +d[2], +d[3], Math.floor(m / 60), m % 60);
}

// ---- EM-0110: the change of a city ticket bought shortly before, as in the Android app (Fares.heldTicket)

/** The town of a city bus boarded at stopName ("Banská Bystrica, Námestie slobody"), null for any other bus. */
export function cityTown(line, stopName) {
  // Regional SAD lines are six digits (060411), trains have letters; city buses and trolleybuses are short numbers.
  // A train is its kind and number ("R 842", EM-0119): a word in front counts only when it is "Bus".
  const words = String(line || '').trim().split(' ');
  if ((words.length > 1 && words[0] !== 'Bus') || !/^\d{1,3}[A-Z]?$/.test(words.at(-1))) return null;
  return ['Zvolen', 'Banská Bystrica'].find((town) => String(stopName || '').startsWith(town + ',')) || null;
}

/**
 * The city ticket still in its time, from the city buses the rider followed (the card's history arrives too late).
 * Replayed by the tariff's rules: a ride within the ticket's time is its change (Banská Bystrica one at 0,10 €, Zvolen
 * any number, free), else a new ticket. { tariffId, boughtMs, changed } or null.
 */
export function heldTicket(tariffs, rides, now = Date.now()) {
  const byTown = Object.fromEntries(Object.values(tariffs || {}).filter((t) => t.flat && t.transferMinutes > 0 && (t.name || '').startsWith('MHD '))
    .map((t) => [t.name.slice(4).trim(), t]));
  let ticket = null;
  for (const r of [...rides].sort((a, b) => a.boardedMs - b.boardedMs)) {
    const t = byTown[r.town];
    if (!t) continue;
    ticket = ticket && ticket.tariffId === t.id && r.boardedMs - ticket.boughtMs <= t.transferMinutes * 60000 && (t.transferCents === 0 || !ticket.changed)
      ? { ...ticket, changed: t.transferCents > 0 } : { tariffId: t.id, boughtMs: r.boardedMs, changed: false };
  }
  const minutes = ticket && tariffs[ticket.tariffId]?.transferMinutes;
  return ticket && minutes && now - ticket.boughtMs <= minutes * 60000 ? ticket : null;
}
