// Differential report validation against the original, bounded source snapshot.
// No event rows, properties, identities or credentials are written to the receipt.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { queryBigQuery, compileAnalyticsQuery } from '../../utils/bigQueryAnalytics.js';
process.env.TZ='UTC';
const environment=process.argv[2];if(!['dev','prod'].includes(environment))throw Error('Specify dev or prod');
function cloud(args){return execFileSync(process.platform==='win32'?'gcloud.cmd':'gcloud',args,{shell:process.platform==='win32',encoding:'utf8',stdio:['ignore','pipe','pipe']});}
const secret=JSON.parse(cloud(['secrets','versions','access','latest',`--secret=auth-service-secrets-${environment}`,'--project=phool-gobhi']));
const token=cloud(['auth','print-access-token']).trim();
const client={async request({url,method='GET',data}){const response=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const result=await response.json();if(!response.ok)throw Error(result.error?.message||'warehouse request failed');return {data:result};}};
const receipt=JSON.parse(readFileSync(`docs/analytics-backfill-${environment}-receipt.json`));
const fixtures=JSON.parse(readFileSync(process.argv[3] || 'tools/analytics/report-queries.json'));
const source=new pg.Client({connectionString:secret.ANALYTICS_DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:30000});
const results=[];
function canonical(value){if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function normalize(rows,fields){return rows.map(row=>{
  const value={...row};for(const field of fields||[])if([20,21,23,700,701,1700].includes(field.dataTypeID)&&value[field.name]!=null)value[field.name]=Number(value[field.name]);
  return JSON.stringify(canonical(value));
}).sort();}
try{
 await source.connect();await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await source.query("SET LOCAL TIME ZONE 'UTC'");
 for(let index=0;index<fixtures.length;index++){
  const fixture=fixtures[index];
  try{
   const maximum=fixture.params.length+1,asof=maximum+1;
   const query=fixture.sql.replace(/\bnow\(\)/gi,`($${asof}::timestamptz)`).replace(/\banalytics_events\b/g,
    `(SELECT * FROM public.analytics_events WHERE id<=$${maximum}::bigint AND ts<=$${asof}::timestamptz)`);
   const legacy=await source.query(query,[...fixture.params,receipt.maximumLegacyId,receipt.asOf]);
   const options={client,asOf:receipt.asOf,dataset:'analytics_'+environment};
   let warehouse;
   if (fixture.nativeSql) {
    const {queryParameters}=compileAnalyticsQuery('SELECT 1',[],options);
    const sql=fixture.nativeSql.replace(/WAREHOUSE_EVENTS/g,'`phool-gobhi.analytics_'+environment+'.events_between`(@scan_since,@as_of,@event_names)');
    warehouse=await queryBigQuery(sql,[],{...options,native:true,queryParameters});
   } else warehouse=await queryBigQuery(fixture.sql,fixture.params,options);
   const a=normalize(legacy.rows,legacy.fields),b=normalize(warehouse.rows);
   const same=JSON.stringify(a)===JSON.stringify(b);
   const hash=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
   results.push({index,report:fixture.report,passed:same,postgresRows:a.length,warehouseRows:b.length,
    sourceResultSha256:hash(a),warehouseResultSha256:hash(b),processedBytes:warehouse.metadata.processedBytes});
  }catch(error){results.push({index,report:fixture.report,passed:false,error:error.message});}
 }
 await source.query('ROLLBACK');
}finally{await source.end();}
writeFileSync(process.argv[4] || `docs/analytics-report-parity-${environment}.json`,JSON.stringify({environment,asOf:receipt.asOf,results},null,2)+'\n');
console.log(JSON.stringify({environment,queries:results.length,passed:results.filter(result=>result.passed).length,
 failures:results.filter(result=>!result.passed).map(({index,report,error,postgresRows,warehouseRows})=>({index,report,error,postgresRows,warehouseRows}))}));
if(results.some(result=>!result.passed))process.exitCode=1;
