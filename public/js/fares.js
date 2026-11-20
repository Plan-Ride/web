// 2.18.0: what a journey costs with the transport cards and whether the credit covers it, as in the Android app
// (Fares.kt). The prices are the carriers' own price lists kept in emHUB (GET /api/hub/fares); each planner leg says
// which tariff it goes by. Amounts in cents, the card price (what the credit pays).
import { walletForLine } from './logic.js';

/** emHUB's price lists as { id: tariff }, or null. */
export function parseTariffs(json) {
  const card = (v) => (Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : null); // [card, cash]
  try {
    return Object.fromEntries(json.tariffs.map((t) => [t.id, t.kind === 'flat'
      ? { id: t.id, flat: true, transferMinutes: t.transferMinutes || 0, transferCents: t.transferCents || 0,
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
export function journeyCost(tariffs, segments, category, cityPass, regionPass) {
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
