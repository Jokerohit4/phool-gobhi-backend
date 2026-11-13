import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const investor=require('../../scripts/investor-metrics.cjs');
const native=require('../../scripts/investor-warehouse-queries.cjs');
const fixtures=Object.entries(investor).map(([name,q])=>({report:'investor_'+name,sql:q.sql,params:[],nativeSql:native[name]}));
const source=readFileSync('scripts/analytics-digest.cjs','utf8');
for(const [index,match] of [...source.matchAll(/client.query\(\s*`([\s\S]*?)`(?:,\s*\[FUNNEL\])?/g)].entries()) {
 fixtures.push({report:'digest_'+index,sql:match[1],params:match[0].includes('[FUNNEL]')?[['gym_viewed','slot_selected','book_tapped','booking_confirmed']]:[]});
}
writeFileSync('tools/analytics/cli-queries.json',JSON.stringify(fixtures,null,2)+'\n');
console.log(JSON.stringify({queries:fixtures.length}));
