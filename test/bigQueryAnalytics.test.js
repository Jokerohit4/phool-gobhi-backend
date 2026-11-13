import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileAnalyticsQuery,queryBigQuery} from '../utils/bigQueryAnalytics.js';
const options={dataset:'analytics_dev',asOf:'2026-10-25T21:49:14.083833Z'};

test('property selection is bound, and full-history cohort/identity reads retain history',()=>{
 const key='x\") OR TRUE --';
 const compiled=compileAnalyticsQuery('SELECT properties ->> $1 AS value FROM analytics_events',[key],options);
 assert.ok(!compiled.query.includes(key));
 assert.ok(compiled.queryParameters.some(p=>p.parameterValue.value==='$.'+JSON.stringify(key)));
 assert.equal(compiled.queryParameters.find(p=>p.name==='scan_since').parameterValue.value,'1970-01-01T00:00:00Z');
 const bounded=compileAnalyticsQuery("SELECT count(*) FROM analytics_events WHERE ts > now() - ($1 || ' days')::interval",[7],options);
 assert.match(bounded.queryParameters.find(p=>p.name==='scan_since').parameterValue.value,/2026-10-18/);
 assert.throws(()=>compileAnalyticsQuery('SELECT 1',[],{...options,dataset:'analytics_dev` UNION ALL SELECT 1'}));
});

test('multi-source identity queries do not restrict journey events to identify',()=>{
 const query="WITH ids AS (SELECT distinct_id FROM analytics_events WHERE event = 'identify') SELECT event FROM analytics_events";
 const compiled=compileAnalyticsQuery(query,[],options);
 assert.deepEqual(compiled.queryParameters.find(p=>p.name==='event_names').parameterValue.arrayValues,[]);
});

test('paginated REST results preserve all rows and PostgreSQL-compatible values',async()=>{
 const fields=[{name:'n',type:'INTEGER'},{name:'ts',type:'TIMESTAMP'},{name:'properties',type:'STRING'}];
 const row=n=>({f:[{v:String(n)},{v:'1792964954.083833'},{v:'{"app":"website"}'}]});
 let count=0;
 const client={async request({url,data}){
  count++;
  if(count===1){assert.equal(data.maximumBytesBilled,'268435456');return {data:{jobComplete:true,schema:{fields},jobReference:{jobId:'test-job'},rows:[row(1)],pageToken:'page2',totalBytesProcessed:'100'}};}
  assert.match(url,/pageToken=page2/);
  return {data:{jobComplete:true,rows:[row(2)]}};
 }};
 const result=await queryBigQuery('SELECT 1',[],{...options,client});
 assert.equal(count,2);assert.deepEqual(result.rows.map(r=>r.n),[1,2]);
 assert.deepEqual(result.rows[1].properties,{app:'website'});assert.ok(result.rows[0].ts instanceof Date);
 assert.equal(result.metadata.processedBytes,100);
});
