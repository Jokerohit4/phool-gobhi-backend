// Probe public ingestion with a synthetic identity; clean up only this probe.
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
const environment=process.argv[2];if(!['dev','prod'].includes(environment))throw Error('Specify dev or prod');
function cloud(args){return execFileSync(process.platform==='win32'?'gcloud.cmd':'gcloud',args,{shell:process.platform==='win32',encoding:'utf8',stdio:['ignore','pipe','pipe']});}
const token=cloud(['auth','print-access-token']).trim();
const secret=JSON.parse(cloud(['secrets','versions','access','latest',`--secret=auth-service-secrets-${environment}`,'--project=phool-gobhi']));
const eventId=randomUUID(),actor='migration-probe:'+randomUUID(),event='screen_viewed';
const deliveryId='client:'+createHash('sha256').update(JSON.stringify([actor,event,eventId])).digest('hex');
async function query(sql){
 const response=await fetch('https://bigquery.googleapis.com/bigquery/v2/projects/phool-gobhi/queries',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query:sql,useLegacySql:false,location:'asia-south1',timeoutMs:20000,maximumBytesBilled:'268435456'})});
 const result=await response.json();if(!response.ok||!result.jobComplete||result.errors?.length)throw Error('Probe warehouse check failed');return result;
}
const dataset='`phool-gobhi.analytics_'+environment+'.';
const payload={event,distinct_id:actor,event_id:eventId,occurred_at:new Date().toISOString(),properties:{app:'migration_probe',screen_name:'migration_probe',ip:'192.0.2.1',user_agent:'synthetic'}};
const statuses=[];
let delivered=false,privacy=false,dedup=false,originalOccurrencePreserved=false,legacyRows;
try{
 for(let i=0;i<2;i++){
  const response=await fetch(`https://gateway-${environment}-pwixdiy6va-el.a.run.app/api/events`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  statuses.push(response.status);if(response.status!==202)throw Error('Gateway did not acknowledge publish: '+response.status);
 }
 for(let attempt=0;attempt<40;attempt++){
  const r=await query(`SELECT COUNT(*) AS raw_copies,COUNTIF(JSON_VALUE(properties,'$.ip') IS NOT NULL OR JSON_VALUE(properties,'$.user_agent') IS NOT NULL) AS private_fields,COUNTIF(ts!=TIMESTAMP('${payload.occurred_at}')) AS changed_timestamp FROM ${dataset}events_raw\` WHERE ts>=TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 1 DAY) AND event_id='${deliveryId}'`);
  const [copies,fields,changed]=r.rows[0].f.map(f=>Number(f.v));
  if(copies>=2){delivered=true;privacy=fields===0;originalOccurrencePreserved=changed===0;break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 const r=await query(`SELECT COUNT(*) AS n FROM ${dataset}events_between\`(TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 1 DAY),CURRENT_TIMESTAMP(),['screen_viewed']) WHERE event_id='${deliveryId}'`);
 dedup=Number(r.rows[0].f[0].v)===1;
 const source=new pg.Client({connectionString:secret.ANALYTICS_DATABASE_URL,connectionTimeoutMillis:10000});
 try{await source.connect();await source.query('BEGIN READ ONLY');legacyRows=Number((await source.query('SELECT COUNT(*) AS n FROM analytics_events WHERE distinct_id=$1',[actor])).rows[0].n);await source.query('ROLLBACK');}finally{await source.end();}
 if(!delivered||!privacy||!dedup||!originalOccurrencePreserved||legacyRows!==0)throw Error('Live ingestion migration gate failed');
}finally{
 await query(`INSERT INTO ${dataset}erased_actors\`(distinct_id,erased_at) VALUES ('${actor}',CURRENT_TIMESTAMP())`);
 await query(`DELETE FROM ${dataset}events_raw\` WHERE ts>=TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 1 DAY) AND distinct_id='${actor}'`);
}
const result={environment,httpStatuses:statuses,managedDeliveryPassed:delivered,rawIpAndUserAgentOmitted:privacy,httpRetryDeduplicated:dedup,originalOccurrencePreserved,legacyRows,probeCleanedUp:true,passed:true};
writeFileSync(`docs/analytics-ingestion-${environment}.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
