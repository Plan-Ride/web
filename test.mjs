// Run: node test.mjs
import assert from 'node:assert/strict';
import { tripProgress, usualAt, usualNow, catchEstimate, communityKey, lineNumber, historyInsights, historyToCsv, snapToRoute, delayAt, nextCheckMs, stopPassDetector, nextRideDeparture, pickRideConnection, earliestBoardingMs, WORKDAYS, BUS_GPS_MAX_M, RIDER_GPS_MAX_M } from './public/js/logic.js';
import { hubTrip, tripUrl, parseTripUrl, localToEpoch, rainOrder } from './transit.js';
import { plannerLeg } from './public/js/logic.js';

const T0 = Date.UTC(2026, 8, 24, 10, 0);
const stops = [0, 5, 10, 15].map((m, i) => ({ name: `S${i}`, platformId: i + 1, order: i + 1, scheduledMs: T0 + m * 60000, actualMs: null }));
const detail = { line: '507', stops, delaySeconds: 0 };

// Waiting at stop 2, bus between S0 and S1.
let p = tripProgress(detail, { boardingPlatformIds: [3], alightOrder: 4 }, T0 + 2.5 * 60000);
assert.equal(p.onBoard, false);
assert.equal(p.nextIndex, 1);
assert.ok(Math.abs(p.position - 0.5) < 1e-9);
assert.equal(p.secondsToBoarding, 450);

// A +5 min delay shifts everything.
p = tripProgress({ ...detail, delaySeconds: 300 }, { boardingPlatformIds: [3], alightOrder: 4 }, T0 + 12 * 60000);
assert.equal(p.onBoard, false, 'with delay the bus has not reached S2 yet');
assert.equal(p.nextIndex, 2);

// Past the alight stop -> finished.
assert.equal(tripProgress(detail, { boardingPlatformIds: [1], alightOrder: 2 }, T0 + 7 * 60000).finished, true);

assert.deepEqual(catchEstimate(600, 900), { walkSeconds: 600, marginSeconds: 300, verdict: 'leaveSoon' });
assert.equal(catchEstimate(600, 400).verdict, 'miss');
assert.equal(catchEstimate(30, 10).verdict, 'atStop');
// EM-0072: by car the router's drive time counts (no parking); without it about 50 km/h; a close stop is still a walk.
assert.equal(catchEstimate(4000, 1800, true, 330).walkSeconds, 330);
assert.equal(catchEstimate(4000, 1800, true).walkSeconds, 402);
assert.equal(catchEstimate(200, 600, true).walkSeconds, catchEstimate(200, 600).walkSeconds);
// location checks before the stop: 3/4 of the walk, every 1 to 3 min
assert.equal(nextCheckMs(120), 90000);
assert.equal(nextCheckMs(10), 60000);
assert.equal(nextCheckMs(460), 180000);
// the moment the bus left or passed a stop
{
  const pass = stopPassDetector();
  assert.equal(pass(0.8, true, 0), null);
  assert.deepEqual(pass(1.2, true, 10000), [1, 5000, false]); // drove past
  const dwell = stopPassDetector();
  dwell(0.9, true, 0);
  assert.equal(dwell(1.01, false, 10000), null); // stopped just past the stop
  assert.equal(dwell(1.01, false, 40000), null);
  assert.deepEqual(dwell(1.2, true, 50000), [1, 45000, true]); // left when it moved again
  const before = stopPassDetector();
  before(0.9, true, 0);
  before(0.99, false, 10000, true); // standing at the stop, just before its point
  assert.equal(before(1.2, true, 50000)[2], true);
  // EM-0007: crosses the stop point moving, halts 20 m further on, drives on -> stopped, not passed
  const past = stopPassDetector();
  const fixes = [[0.8, true, false], [0.97, true, true], [1.03, true, true], [1.04, false, true], [1.04, false, true], [1.04, false, true], [1.08, true, true], [1.3, true, false]];
  const out = fixes.map(([i, m, a], n) => past(i, m, n * 5000, a)).filter(Boolean);
  assert.deepEqual(out, [[1, 27500, true]]);
  // EM-0091: pulls into the bay (still in the area), stands 7 min, then leaves -> left when it last started moving
  const bay = stopPassDetector();
  const bayOut = [[0.9, true, false, 0], [1.01, false, true, 10000], [1.03, true, true, 15000], [1.04, false, true, 20000], [1.04, false, true, 440000], [1.08, true, true, 450000], [1.3, true, false, 460000]]
    .map(([i, m, a, t]) => bay(i, m, t, a)).filter(Boolean);
  assert.deepEqual(bayOut, [[1, 445000, true]]);
  // drives through the stop's area without stopping -> passed, decided once out of the area
  const through = stopPassDetector();
  const got = [[0.8, true, false], [0.95, true, true], [1.05, true, true], [1.3, true, false]].map(([i, m, a], n) => through(i, m, n * 5000, a)).filter(Boolean);
  assert.equal(got.length, 1);
  assert.equal(got[0][2], false);
}

// ---- regular rides (same rules as the Android app)
{
  const ride = { id: 'r', route: {}, time: '07:25', lines: ['101'], days: WORKDAYS, dates: [], leadMinutes: 10, enabled: true };
  const at = (y, mo, d, h, mi) => localToEpoch(y, mo, d, h, mi);
  // Friday 2026-10-02: after 7:15 the next one is Monday
  assert.equal(nextRideDeparture(ride, at(2026, 10, 2, 8, 0)), at(2026, 10, 5, 7, 25));
  assert.equal(nextRideDeparture(ride, at(2026, 10, 2, 7, 16)), at(2026, 10, 5, 7, 25));
  assert.equal(nextRideDeparture(ride, at(2026, 10, 2, 7, 14)), at(2026, 10, 2, 7, 25));
  const ranged = { ...ride, time: '18:00', days: [6], dates: ['2026-10-07'], startDate: '2026-10-10', endDate: '2026-10-17' };
  assert.equal(nextRideDeparture(ranged, at(2026, 10, 1, 12, 0)), at(2026, 10, 7, 18, 0));
  assert.equal(nextRideDeparture(ranged, at(2026, 10, 8, 12, 0)), at(2026, 10, 10, 18, 0));
  assert.equal(nextRideDeparture(ranged, at(2026, 10, 18, 0, 0)), null);
  assert.equal(nextRideDeparture({ ...ride, enabled: false }, at(2026, 10, 1, 0, 0)), null);
  const conn = (id, time, ...lines) => ({ id, segments: lines.map((l) => ({ line: 'Bus ' + l, departureTime: time, serviceDate: '2026-10-05' })) });
  const dep = at(2026, 10, 5, 7, 25);
  assert.equal(pickRideConnection([conn('a', '7:20', '106'), conn('b', '7:25', '101'), conn('c', '7:40', '101')], ride, dep).id, 'b');
  assert.equal(pickRideConnection([conn('a', '7:24', '106'), conn('c', '7:30', '101')], ride, dep).id, 'c');
  assert.equal(pickRideConnection([conn('x', '9:00', '5')], ride, dep), null);
  // earliest boarding: a bus that usually leaves 3 min early (nothing live known) counts as 3 min earlier
  const d = { stops: [{ scheduledMs: 1_000_000 }], delaySeconds: 0, history: { delaySeconds: -180 } };
  assert.equal(earliestBoardingMs(d, { boardingIndex: 0, boardingExpectedMs: 1_000_000 }, false), 1_000_000 - 180_000);
  assert.equal(earliestBoardingMs(d, { boardingIndex: 0, boardingExpectedMs: 1_000_000 }, true), 1_000_000);
  // EM-0096: usually 13 min late, nothing known: it can still come on time; a known delay is counted
  assert.equal(earliestBoardingMs({ stops: d.stops, delaySeconds: 780 }, { boardingIndex: 0, boardingExpectedMs: 1_780_000 }, false), 1_000_000);
  assert.equal(earliestBoardingMs({ stops: d.stops, delaySeconds: 780 }, { boardingIndex: 0, boardingExpectedMs: 1_780_000 }, true), 1_780_000);
}
assert.equal(communityKey(detail), `507|S0|${T0}`);
assert.equal(communityKey(detail, { lineId: 910009139, tripNumber: 123, line: '1' }), 'sadzv|910009139|123|2026-09-24|1');

// GPS on the route (same cases as the Android RoutePositionTest)
const route = [[48.570, 19.125], [48.580, 19.125], [48.590, 19.125], [48.600, 19.125]];
assert.ok(Math.abs(snapToRoute(48.5825, 19.1252, route, BUS_GPS_MAX_M).index - 1.25) < 0.03);
assert.equal(snapToRoute(48.73, 19.15, route, BUS_GPS_MAX_M), null, 'far off the route: wrong trip');
assert.equal(snapToRoute(48.648, 19.12, [[48.50, 19.12], [48.635, 19.12]], RIDER_GPS_MAX_M), null, 'EM-0063: 1.5 km past a long hop is off the route');
assert.equal(snapToRoute(48.5825, 19.1272, route, RIDER_GPS_MAX_M), null, 'rider beside the road is not on the bus');
const loop = [[48.570, 19.125], [48.580, 19.125], [48.590, 19.125], [48.580, 19.125], [48.570, 19.125]];
assert.ok(Math.abs(snapToRoute(48.575, 19.125, loop, 300, 0.4).index - 0.5) < 0.05);
assert.ok(Math.abs(snapToRoute(48.575, 19.125, loop, 300, 3.6).index - 3.5) < 0.05);
assert.ok(Math.abs(snapToRoute(48.65, 19.1268, [[48.70, 19.12], [48.60, 19.12]], RIDER_GPS_MAX_M).index - 0.5) < 0.05); // 500 m off an 11 km hop: a bending road
const sched = [0, 3, 6, 9].map((m) => T0 + m * 60000);
assert.equal(delayAt(1.5, sched, T0 + 6 * 60000), 90);
assert.equal(delayAt(2, sched, T0 + 5 * 60000), 0); // waiting at a stop before its departure: on time
assert.equal(delayAt(1.5, sched, T0 + 2 * 60000), -60); // left stop 1 a minute early
assert.equal(lineNumber('Bus 507105'), '507105');

// Timetable trips from emhub: boarding and alighting come from the trip link; where you get off, the arrival counts.
const link = parseTripUrl(tripUrl('sad-zvolen-as:T-5:20260924', 1, 2));
assert.deepEqual(link, { id: 'sad-zvolen-as:T-5:20260924', from: 1, to: 2 });
assert.equal(parseTripUrl('https://cp.sk/vlakbusmhd/draha/?x=1'), null, 'old cp.sk links are not ours');
const at = (h, m, d = 24) => localToEpoch(2026, 9, d, h, m);
const trip = hubTrip({ headsign: '', stops: [
  { name: 'Zvolen, AS', arrival: at(23, 40), departure: at(23, 40), lat: 48.57, lon: 19.12 },
  { name: 'Sliač, kúpele', arrival: at(23, 55), departure: at(23, 55), platform: '3', lat: 48.6, lon: 19.14, platformId: 385 },
  { name: 'Banská Bystrica, AS', arrival: at(0, 15, 25), departure: at(0, 20, 25), lat: null, lon: null },
  { name: 'Brezno, AS', arrival: at(1, 5, 25), departure: at(1, 5, 25) },
] }, { line: '507', destination: '' }, link.from, link.to);
assert.equal(trip.stops.length, 4);
assert.equal(trip.boardingOrder, 2);
assert.equal(trip.alightOrder, 3);
assert.deepEqual(trip.stops.map((s) => s.platform), ['', '3', '', '']);
assert.deepEqual(trip.stops.map((s) => [s.platformId, s.livePlatformId]), [[1, 0], [2, 385], [3, 0], [4, 0]], 'EM-0090: the live platform is kept beside the stop number');
assert.equal(trip.stops[1].scheduledMs, at(23, 55));
assert.equal(trip.stops[2].scheduledMs, at(0, 15, 25), 'alight uses arrival');
assert.equal(trip.stops[2].lat, null);
assert.equal(trip.destination, 'Brezno, AS');
// A city bus from SAD Zvolen's live data is followed live, from the stop where the user gets on.
const liveLeg = plannerLeg({ line: 'Bus 9', departureStop: 'Zvolen, AS', departureTime: '21:43', arrivalStop: 'Lipovec, Potraviny', arrivalTime: '21:58', serviceDate: '2026-09-29',
  routeUrl: 'sadzv:trip?line=9&lineId=910009195&route=9004&trip=67&board=1296&alight=12&stop=4913&planned=78180' });
assert.deepEqual(liveLeg, { ref: { line: '9', lineId: 910009195, routeNumber: '9004', tripNumber: 67, destination: 'Lipovec, Potraviny',
  scheduleUrl: '', serviceDate: '2026-09-29', fromStopId: 4913, plannedSecondOfDay: 78180 }, boardingPlatformIds: [1296], alightOrder: 12,
  // EM-0067: where and when the rider gets on and off, for the whole journey's list.
  fromStop: 'Zvolen, AS', toStop: 'Lipovec, Potraviny', leaves: '21:43', arrives: '21:58' });
// On another day a city bus opens from the timetable (sadzv only knows today's run).
const tomorrowLeg = plannerLeg({ line: 'Bus 9', arrivalStop: 'Lipovec, Potraviny', serviceDate: '2099-01-01',
  routeUrl: 'sadzv:trip?line=9&lineId=1&route=9004&trip=67&board=1296&alight=12&stop=4913&planned=78180&tt=' + encodeURIComponent(tripUrl('sad-zvolen-as-city:x:20990101', 6, 10)) });
assert.deepEqual([tomorrowLeg.ref.lineId, tomorrowLeg.ref.scheduleUrl], [0, tripUrl('sad-zvolen-as-city:x:20990101', 6, 10)]);
const ttLeg = plannerLeg({ line: 'Bus 60107', arrivalStop: 'Banská Bystrica, AS', serviceDate: '2026-09-30', routeUrl: tripUrl('x:y:20260930', 0, 5) });
assert.equal(ttLeg.ref.scheduleUrl, tripUrl('x:y:20260930', 0, 5));
assert.deepEqual([ttLeg.ref.line, ttLeg.boardingPlatformIds, ttLeg.alightOrder], ['60107', [], null]);
// Europe/Bratislava is UTC+2 in September.
assert.equal(localToEpoch(2026, 9, 24, 12, 0), Date.UTC(2026, 8, 24, 10, 0));

const items = [
  { sourceType: 'TICKET', isTopUp: false, amountCents: -90, timestampMs: Date.UTC(2026, 8, 3, 8), stopName: 'Zvolen, AS', title: 'Jednorazový' },
  { sourceType: 'TICKET', isTopUp: false, amountCents: -110, timestampMs: Date.UTC(2026, 8, 4, 8), stopName: 'Zvolen, AS', title: 'Jednorazový, "x"' },
  { sourceType: 'TICKET', isTopUp: true, amountCents: 1000, timestampMs: Date.UTC(2026, 8, 1, 8), stopName: '', title: 'Vklad' },
];
const ins = historyInsights(items, 5.0, new Date(2026, 8, 24));
assert.equal(ins.months.at(-1).spentCents, 200);
assert.equal(ins.averageFareCents, 100);
assert.equal(ins.tripsLeft, 5);
assert.deepEqual(ins.topStops[0], ['Zvolen, AS', 2]);
assert.ok(historyToCsv(items).includes('"Jednorazový, ""x"""'));
// Times are real UTC: 08:00 UTC is 10:00 in Bratislava in September (run with TZ=Europe/Bratislava).
if (process.env.TZ === 'Europe/Bratislava') assert.ok(historyToCsv(items).includes('2026-09-03 10:00'));

console.log('ok');

// ---- 2.13: which ticket a bus takes, and the IDS BBSK e-shop pages (trimmed copies, made-up card numbers)
{
  const { walletForLine } = await import('./public/js/logic.js');
  assert.equal(walletForLine('34'), 'sadzv');
  assert.equal(walletForLine('60101'), 'ids');
  assert.equal(walletForLine('Bus 060400'), 'ids');
  assert.equal(walletForLine('609503'), null);
  const ids = await import('./ids.js');
  const ticket = `<tr class="my-tickets__table-row" data-id-order-detail="2">
    <td><div class="my-tickets__table-highlight breakable"> IDS Sieťovka 365 dní </div><div class="my-tickets__msg-alert"> Platnosť l&iacute;stka vypr&scaron;ala </div></td>
    <td> od: 29. 8. 2025 13:28 do: 28. 8. 2026 23:59 </td><td> identifikátor č. 5 <br>(NFC Karta) <br>01C55703 </td><td> 399,00 € </td></tr>`;
  const [t] = ids.parseTickets(ticket);
  assert.equal(t.price, '399,00 €'); // the card number right before the price isn't part of it
  assert.equal(t.valid, false);
  assert.equal(t.identifierNumber, 5);
  assert.equal(new Date(t.validFromMs).toISOString(), '2025-08-29T11:28:00.000Z'); // Slovak summer time
  assert.equal(ids.idsHistory({ tickets: [t], topUps: [] })[0].amountCents, -39900);
  const [card] = ids.parseIdentifiers(`<tr class="my-tokens__table-row" data-token="B"><td><div>Identifik&aacute;tor č. 5</div></td>
    <td><input class="my-tokens__card-info token-alias-input" value="NFC Karta" disabled /></td><td><a href="x">Platné lístky: 1</a></td>
    <td><div class="my-tokens__msg-success"> Platn&yacute; </div></td></tr>`);
  assert.ok(card.hasProducts && card.valid && card.alias === 'NFC Karta');
  assert.equal(ids.parseCredit('<div class="my-credit__credit-amount">\n 0,15\n</div>'), 0.15);
  console.log('ok 2.13: tickets by bus, IDS BBSK pages');
}

// EM-0059: from a minute before the bus is due at a stop, that stop is "now" (the alerts still go by nextIndex).
{
  const t0 = 1_800_000_000_000;
  const stop = (name, order, min) => ({ name, platformId: order, order, scheduledMs: t0 + min * 60000, actualMs: null });
  const d = { delaySeconds: 0, stops: [stop('A', 1, 0), stop('B', 2, 10), stop('C', 3, 12)] };
  const between = tripProgress(d, { boardingPlatformIds: [], alightOrder: null }, t0 + 5 * 60000);
  assert.equal(between.currentStopName, 'A'); assert.equal(between.nextStopName, 'B');
  const arriving = tripProgress(d, { boardingPlatformIds: [], alightOrder: null }, t0 + 9.5 * 60000);
  assert.equal(arriving.currentStopName, 'B'); assert.equal(arriving.nextStopName, 'C'); assert.equal(arriving.nextIndex, 1);
  console.log('ok 2.15.1: the stop the bus is at is "now"');
}

// 2.17.2: how late a bus usually is, per stop: between two stops their average; times predicted per stop
{
  const st = [0, 1, 2, 3].map((i) => ({ name: 'S' + i, platformId: i + 1, order: i + 1, scheduledMs: i * 600000, actualMs: null }));
  const h = { delaySeconds: 120, runs: 5, lateRuns: 3, dayType: 'workday', byStop: [0, 60, 300, 600] };
  assert.equal(usualNow(h, st, 900000), 180);
  assert.equal(usualNow(h, st, -1), 0);
  assert.equal(usualAt({ ...h, byStop: undefined }, 2), 120, 'an older emHUB: the whole trip');
  const p = tripProgress({ stops: st, delaySeconds: 180, positionSource: 'history', history: h }, { boardingPlatformIds: [3] }, 0);
  assert.deepEqual(p.expected, [0, 660000, 1500000, 2400000]);
  console.log('ok 2.17.2: usual delay per stop');
}

// EM-0081: in the rain a 6-minute walk sinks a bus only below drier ones that arrive within 15 min.
{
  const m = 60000, c = (id, arrivalMs, walkMinutes) => ({ id, arrivalMs, walkMinutes });
  const order = rainOrder([c('7:32 walk', 60 * m, 6), c('7:40 dry', 70 * m, 0), c('8:50 dry', 140 * m, 0)]).map((x) => x.id);
  assert.deepEqual(order, ['7:40 dry', '7:32 walk', '8:50 dry']);
  console.log('ok 2.18.0: rain order within reason');
}

// ---------------------------------------------------------------- 2.18.0 web port
{
  const { onTripDay, plannerModes } = await import('./transit.js');
  const { lineKind } = await import('./public/js/logic.js');
  const { journeyCost, parseTariffs, fareCategory } = await import('./public/js/fares.js');

  // EM-0118: sadzv dated a 13:17 bus of 20.11. with 19.11.: its stops go on the trip's day (the nearest to now).
  const at = (d, h, m) => localToEpoch(2026, 11, d, h, m);
  const st = [[13, 17], [13, 40], [23, 50], [0, 10]].map(([h, m], i) => ({ name: 'S' + i, scheduledMs: at(19, h, m) }));
  onTripDay(st, '', at(20, 12, 40));
  assert.deepEqual(st.map((s) => s.scheduledMs), [at(20, 13, 17), at(20, 13, 40), at(20, 23, 50), at(21, 0, 10)], 'EM-0118: on its day, past midnight the next');
  const dated = [{ scheduledMs: at(19, 8, 0) }];
  onTripDay(dated, '2026-11-22', at(20, 12, 0));
  assert.equal(dated[0].scheduledMs, at(22, 8, 0), 'EM-0118: a service date wins');

  assert.equal(lineKind('R 845'), 'rail');
  assert.equal(lineKind('Bus 60107', 'bus', 'bus'), 'bus');
  assert.equal(lineKind('Bus 9', 'city', 'tram'), 'tram');
  assert.equal(lineKind('Bus 12', 'city', 'bus'), 'city');
  assert.equal(plannerModes('rail,bogus'), 'rail');
  assert.equal(plannerModes(''), 'bus,city,rail', 'none chosen: all');

  // Fares: a city ticket covers a change within its time (Banská Bystrica: 0,10 € once), IDS BBSK by units, trains "+ train".
  const tariffs = parseTariffs({ tariffs: [
    { id: 'bb', kind: 'flat', transferMinutes: 40, transferCents: 10, prices: { full: [90, 120], student: [45, 60] } },
    { id: 'ids', kind: 'units', as: { full: 'full', student: 'discount' }, bands: [{ upTo: 2, full: [80, 100], discount: [40, 50] }, { upTo: 6, full: [150, 180], discount: [75, 90] }] },
  ] });
  const seg = (line, time, extra) => ({ line, departureTime: time, operatorName: '', group: 'bus', ...extra });
  let cost = journeyCost(tariffs, [seg('Bus 7', '7:00', { tariff: 'bb' }), seg('Bus 31', '7:20', { tariff: 'bb' }), seg('Bus 31', '7:30', { tariff: 'bb' })], 'full', false, false);
  assert.equal(cost.sadzvCents, 90 + 10 + 90, 'one change for 0,10 €, then a new ticket');
  cost = journeyCost(tariffs, [seg('Bus 60101', '8:00', { tariff: 'ids', units: 3 }), seg('R 845', '9:00', { group: 'rail' })], fareCategory(['Žiak/Študent do 26 rokov']), false, false);
  assert.deepEqual([cost.idsCents, cost.train, cost.unknown], [75, true, false], 'student IDS fare by units, plus a train');
  cost = journeyCost(tariffs, [seg('Bus 60101', '8:00', { tariff: 'ids', units: 3 })], 'full', false, true);
  assert.deepEqual([cost.idsCents, cost.covered], [0, true], 'a season ticket covers it');
  console.log('ok 2.18.0 web: trip day, kinds, modes, fares');
}
