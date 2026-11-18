// Account-cohort scoping for admin analytics: parsing, the include/exclude
// resolution against auth-service, the SQL fragments, and that the existing
// BigQuery adapter and Traffic builder accept them.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let authCalls = 0;
let authReply;
let mod;
let compile;
let buildTrafficQuery;

test('setup', async (t) => {
  t.mock.module('axios', { exports: { default: { get: async () => {
    authCalls++;
    if (authReply instanceof Error) throw authReply;
    return { data: { data: authReply } };
  } } } });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  mod = await import('../utils/cohortScope.js');
  ({ compileAnalyticsQuery: compile } = await import('../utils/bigQueryAnalytics.js'));
  ({ buildTrafficQuery } = await import('../services/trafficReport.js'));
});

const reset = () => {
  mod.clearCohortCache();
  authCalls = 0;
  authReply = {
    FRIENDS_AND_FAMILY: ['1', '2'],
    GENERATED_ACCOUNTS: ['3'],
    TESTING_ACCOUNTS: ['4', '5'],
  };
};

test('parseCohortParam: all/empty/everything means no filter; typos are rejected', () => {
  assert.equal(mod.parseCohortParam(undefined), null);
  assert.equal(mod.parseCohortParam(''), null);
  assert.equal(mod.parseCohortParam('all'), null);
  assert.equal(mod.parseCohortParam('FRIENDS_AND_FAMILY,GENERATED_ACCOUNTS,TESTING_ACCOUNTS,UNKNOWN_USERS'), null);
  assert.deepEqual(mod.parseCohortParam('testing_accounts, friends_and_family,TESTING_ACCOUNTS'),
    ['TESTING_ACCOUNTS', 'FRIENDS_AND_FAMILY']);
  assert.throws(() => mod.parseCohortParam('VIP'), { status: 400 });
  assert.throws(() => mod.parseCohortParam('TESTING_ACCOUNTS,VIP'), { status: 400 });
});

test('no filter never calls auth-service', async () => {
  reset();
  assert.deepEqual(await mod.resolveCohortScope('all'), { mode: 'all' });
  assert.equal(authCalls, 0);
});

test('UNKNOWN_USERS alone excludes every non-default cohort', async () => {
  reset();
  const s = await mod.resolveCohortScope('UNKNOWN_USERS');
  assert.equal(s.mode, 'exclude');
  assert.deepEqual([...s.ids].sort(), ['1', '2', '3', '4', '5']);
});

test('UNKNOWN_USERS plus another cohort only excludes the unselected ones', async () => {
  reset();
  const s = await mod.resolveCohortScope('UNKNOWN_USERS,TESTING_ACCOUNTS');
  assert.equal(s.mode, 'exclude');
  assert.deepEqual([...s.ids].sort(), ['1', '2', '3']);
});

test('selecting only named cohorts includes just their ids', async () => {
  reset();
  const s = await mod.resolveCohortScope('FRIENDS_AND_FAMILY,GENERATED_ACCOUNTS');
  assert.equal(s.mode, 'include');
  assert.deepEqual([...s.ids].sort(), ['1', '2', '3']);
});

test('auth-service outage is a 503, never silently unfiltered; results are cached', async () => {
  reset();
  authReply = new Error('down');
  await assert.rejects(mod.resolveCohortScope('TESTING_ACCOUNTS'), { status: 503 });
  reset();
  await mod.resolveCohortScope('TESTING_ACCOUNTS');
  await mod.resolveCohortScope('FRIENDS_AND_FAMILY');
  assert.equal(authCalls, 1);
});

test('cohortClause appends the id list as the next parameter', () => {
  const params = ['x', 30];
  assert.equal(mod.cohortClause({ mode: 'all' }, params), '');
  assert.deepEqual(params, ['x', 30]);
  const inc = mod.cohortClause({ mode: 'include', ids: ['1'] }, params);
  assert.equal(inc, ' AND distinct_id = ANY($3)');
  assert.deepEqual(params, ['x', 30, ['1']]);
  const p2 = [7];
  assert.equal(mod.cohortClause({ mode: 'exclude', ids: ['9'] }, p2, 'e.distinct_id'),
    ' AND (e.distinct_id IS NULL OR NOT (e.distinct_id = ANY($2)))');
});

test('the BigQuery adapter compiles the cohort fragments to UNNEST with a string array', () => {
  const sql = `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event = ANY($1) AND ts > now() - ($2 || ' days')::interval AND (distinct_id IS NULL OR NOT (distinct_id = ANY($3)))
      GROUP BY event`;
  const { query, queryParameters } = compile(sql, [['gym_viewed'], 30, ['1', '2']], { project: 'phool-gobhi', dataset: 'analytics_dev' });
  assert.match(query, /NOT \(distinct_id IN UNNEST\(@p3\)\)/);
  const p3 = queryParameters.find((p) => p.name === 'p3');
  assert.equal(p3.parameterType.type, 'ARRAY');
  assert.deepEqual(p3.parameterValue.arrayValues, [{ value: '1' }, { value: '2' }]);
});

test('Traffic: the default report is byte-for-byte unscoped', () => {
  const asOf = new Date('2026-11-18T00:00:00Z');
  const base = buildTrafficQuery({}, { asOf });
  const all = buildTrafficQuery({}, { asOf, scope: { mode: 'all' } });
  assert.equal(all.sql, base.sql);
  assert.equal(all.values.length, 8);
  assert.equal(base.filters.cohort, undefined);
});

test('Traffic: a scope filters the stitched identity, in both dialects', () => {
  const asOf = new Date('2026-11-18T00:00:00Z');
  const scope = { mode: 'exclude', ids: ['1', '2'], cohorts: ['UNKNOWN_USERS'] };
  const pg = buildTrafficQuery({}, { asOf, scope });
  assert.match(pg.sql, /AND NOT \(COALESCE\(l\.identified_id, r\.distinct_id\) = ANY\(\$9\)\)/);
  assert.deepEqual(pg.values[8], ['1', '2']);
  assert.equal(pg.filters.cohort, 'UNKNOWN_USERS');
  const bq = buildTrafficQuery({}, { asOf, bigQuery: true, scope });
  assert.match(bq.sql, /IN UNNEST\(@p9\)/);
  assert.equal(bq.queryParameters[8].parameterType.type, 'ARRAY');
  const inc = buildTrafficQuery({}, { asOf, scope: { mode: 'include', ids: ['4'], cohorts: ['TESTING_ACCOUNTS'] } });
  assert.match(inc.sql, /AND COALESCE\(l\.identified_id, r\.distinct_id\) = ANY\(\$9\)/);
});
