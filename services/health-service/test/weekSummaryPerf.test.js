// Item 3: GET /week-summary - one doctor-plan read for the whole week (identical
// answers to the per-day activeDoctorPlan, incl. the supersededAt window), the
// live-today resolve overlapping the other reads, and the 15s in-process memo.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

let activeDoctorPlan, activeDoctorPlans, getWeekSummary, emitJourneyInvalidate;
const consent = { scopes: ['medical_records'], scopeVersions: { medical_records: '2026-09-27' } };
const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const planOf = (extra = {}) => ({ version: 1, confirmed: true, startsOn: '2026-10-01', endsOn: null, targets: { kcal: 1500 }, ...extra });

// A fake that applies the SAME supersededAt filter the SQL does, so the two code
// paths can be compared on realistic data.
function store(docs, grant = consent, counts = { consent: 0, docs: 0 }) {
  return {
    counts,
    ledgerConsent: { findUnique: async () => { counts.consent++; return grant; } },
    medicalDocument: {
      findMany: async ({ where }) => {
        counts.docs++;
        const gt = where.OR[1].supersededAt.gt;
        return docs.filter((d) => d.supersededAt == null || d.supersededAt > gt)
          .sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id));
      },
    },
  };
}

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return {}; } }, Prisma: {} } });
  ({ activeDoctorPlan, activeDoctorPlans } = await import('../services/ledger/doctorPlan.js'));
  ({ getWeekSummary } = await import('../services/weekSummaryService.js'));
  ({ emitJourneyInvalidate } = await import('../utils/journeyCacheBus.js'));
});

test('batched doctor plans equal per-day activeDoctorPlan, including a plan superseded mid-week', async () => {
  const docs = [
    { id: 1, createdAt: new Date('2026-10-01'), supersededAt: new Date('2026-10-28T10:00:00+05:30'), structuredPlan: planOf({ targets: { kcal: 1500 } }) },
    { id: 2, createdAt: new Date('2026-10-28'), supersededAt: null, structuredPlan: planOf({ startsOn: '2026-10-28', targets: { kcal: 1800 } }) },
    { id: 3, createdAt: new Date('2026-10-20'), supersededAt: new Date('2026-10-26T01:00:00+05:30'), structuredPlan: planOf({ endsOn: '2026-10-29' }) },
    { id: 4, createdAt: new Date('2026-10-05'), supersededAt: null, structuredPlan: { version: 1, confirmed: false, startsOn: '2026-10-01' } },
  ];
  const batched = await activeDoctorPlans(store(docs), 7, days);
  for (const d of days) {
    assert.deepEqual(batched.get(d), await activeDoctorPlan(store(docs), 7, d), `day ${d}`);
  }
  assert.equal(batched.get('2026-10-27').id, 1, 'before the supersede, the old plan still applied');
  assert.equal(batched.get('2026-10-28').id, 2, 'from the supersede day, the replacement applies');
});

test('batched doctor plans: one consent read + one document read; consent gates every day', async () => {
  const s = store([{ id: 1, createdAt: new Date(), supersededAt: null, structuredPlan: planOf() }]);
  const out = await activeDoctorPlans(s, 7, days);
  assert.deepEqual(s.counts, { consent: 1, docs: 1 }, 'was 2 queries x days');
  assert.ok(days.every((d) => out.get(d)?.id === 1));
  for (const grant of [null, { ...consent, revokedAt: new Date() }, { ...consent, scopes: [] }, { ...consent, scopeVersions: {} }]) {
    const g = store([{ id: 1, createdAt: new Date(), supersededAt: null, structuredPlan: planOf() }], grant);
    const res = await activeDoctorPlans(g, 7, days);
    assert.ok(days.every((d) => res.get(d) === null));
    assert.equal(g.counts.docs, 0);
  }
  assert.deepEqual([...(await activeDoctorPlans({}, 7, days)).values()], days.map(() => null), 'no record store -> no override');
});

function weekPrisma(log) {
  const s = store([{ id: 1, createdAt: new Date('2026-10-01'), supersededAt: null, structuredPlan: planOf() }]);
  return {
    ...s,
    foodLog: { findMany: async () => { log.push('food'); return []; } },
    waterLog: { groupBy: async () => { log.push('water'); await new Promise((r) => setTimeout(r, 20)); log.push('water-done'); return []; } },
    scoreDaySnapshot: { findMany: async ({ select }) => { log.push(['snap', select]); return []; } },
    workoutSession: { findMany: async () => [] },
    nutritionTarget: { findMany: async () => [{ effectiveFrom: '2026-10-01', kcal: 2000, waterMl: 2000 }] },
    healthGoal: { findUnique: async () => null },
  };
}
const deps = (log, extra = {}) => ({
  access: async () => ({ layers: ['plan', 'food', 'water'], onLayerKeys: ['food', 'water'] }),
  cache: { get: async () => null, set: async () => {} },
  showedUp: async () => [],
  resolveDay: async () => { log.push('resolveDay'); await new Promise((r) => setTimeout(r, 5)); return { counts: { done: 1, total: 2 }, earned: 5, target: 10 }; },
  ...extra,
});
const now = new Date('2026-10-30T10:00:00Z');

test('getWeekSummary: doctor target applied, today live-resolved concurrently, snapshot select narrowed', async () => {
  emitJourneyInvalidate(7);
  const log = [];
  const prisma = weekPrisma(log);
  const out = await getWeekSummary(prisma, { userId: 7, now }, deps(log));
  assert.deepEqual(prisma.counts, { consent: 1, docs: 1 });
  assert.equal(out.days[4].food.targetKcal, 1500, 'doctor override reaches the day');
  assert.equal(out.days[4].plan.source, 'live');
  assert.deepEqual(log.find((e) => Array.isArray(e))[1], { localDate: true, paused: true, planSummary: true });
  // resolveDay started before the first read finished (inside the same Promise.all)
  assert.ok(log.indexOf('resolveDay') >= 0 && log.indexOf('resolveDay') < log.indexOf('water-done'));
});

test('getWeekSummary: 15s memo within TTL, evicted by journey invalidation, keyed by access signature', async () => {
  emitJourneyInvalidate(7);
  const log = [];
  const prisma = weekPrisma(log);
  await getWeekSummary(prisma, { userId: 7, now }, deps(log));
  const n = log.length;
  await getWeekSummary(prisma, { userId: 7, now }, deps(log));
  assert.equal(log.length, n, 'second call served from memo');
  // a changed layer set (consent withdrawn / layer unlocked) must not read the old entry
  await getWeekSummary(prisma, { userId: 7, now }, deps(log, { access: async () => ({ layers: ['plan'], onLayerKeys: [] }) }));
  assert.ok(log.length > n, 'different access signature recomputes');
  const n2 = log.length;
  emitJourneyInvalidate(7);
  await getWeekSummary(prisma, { userId: 7, now }, deps(log));
  assert.ok(log.length > n2, 'journey invalidation evicts');
});
