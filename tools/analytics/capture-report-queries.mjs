// Capture real report statements with synthetic parameters; no DB/network I/O.
import { mock } from 'node:test';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
process.env.ANALYTICS_DATABASE_URL = 'postgres://invalid@127.0.0.1:1/never-connect';
const queries = [];
let report;
const require = createRequire(new URL('../../services/booking-service/package.json', import.meta.url));
const pgPath = pathToFileURL(require.resolve('pg')).href;
mock.module(pgPath, { defaultExport: { Pool: class {
  async query(sql, params = []) { queries.push({report,sql,params}); return {rows:[]}; }
} } });
const service = await import(process.argv[3] ? pathToFileURL(resolve(process.argv[3])).href : '../../services/booking-service/services/analyticsQueryService.js');
const special = {
  getGymFunnel:[1,30],getGymRevenueTrend:[1,30],getGymRetentionCohorts:[1,12],
  getKnownEvents:[100],getKnownPropertyKeys:['screen_viewed',50],
  getKnownPropertyValues:['screen_viewed','screen_name',20,'app','website'],
  getRecentAnonSessions:[7,25],searchEventUsers:['screen_viewed',{app:'website'},30,25],
  getCustomFunnel:[[{event:'screen_viewed',filters:{app:'website'}},{event:'book_tapped',filters:{}}],30],
  getUserJourney:['1',90],getTrend:['booking_confirmed,gym_viewed',30],getRetentionCohorts:[12],getLocationReach:[30,20],
};
for (const [name, fn] of Object.entries(service)) {
  if (['resolveDistinctIdFromSearch','getUserProfile'].includes(name)) continue;
  report = name;
  await fn(...(special[name] || [30]));
}
writeFileSync(process.argv[2] || 'tools/analytics/report-queries.json',JSON.stringify(queries,null,2)+'\n');
console.log(JSON.stringify({reports:new Set(queries.map(q=>q.report)).size,queries:queries.length}));
