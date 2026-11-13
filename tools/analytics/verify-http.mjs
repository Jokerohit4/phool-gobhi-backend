// Live HTTP contracts with existing account roles; only aggregate status is kept.
import {execFileSync} from 'node:child_process';
import {createHmac,createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {queryBigQuery} from '../../utils/bigQueryAnalytics.js';
const environment=process.argv[2];if(!['dev','prod'].includes(environment))throw Error('Specify dev or prod');
function cloud(args){return execFileSync(process.platform==='win32'?'gcloud.cmd':'gcloud',args,{shell:process.platform==='win32',encoding:'utf8',stdio:['ignore','pipe','pipe']});}
const secret=JSON.parse(cloud(['secrets','versions','access','latest',`--secret=auth-service-secrets-${environment}`,'--project=phool-gobhi']));
const base=`https://gateway-${environment}-pwixdiy6va-el.a.run.app`;
const source=new pg.Client({connectionString:secret.DATABASE_URL,connectionTimeoutMillis:10000});
const results=[];
function bearer(user){const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const now=Math.floor(Date.now()/1000);const part=encode({alg:'HS256',typ:'JWT'})+'.'+encode({...user,iat:now,exp:now+600});return part+'.'+createHmac('sha256',secret.JWT_SECRET).update(part).digest('base64url');}
try{
 await source.connect();await source.query('BEGIN READ ONLY');
 const roles=(await source.query(`SELECT DISTINCT ON (role) id,role,type FROM auth."User" WHERE "isActive"=true AND role IN ('customer','gobhi') ORDER BY role,id`)).rows;
 await source.query('ROLLBACK');
 const customer=roles.find(r=>r.role==='customer'),admin=roles.find(r=>r.role==='gobhi');
 if(!customer||!admin)throw Error('An existing active customer and gobhi account are needed');
 for(const [route,user,expected] of [
  ['/health',null,200],['/api/auth/app-config',null,200],['/api/auth/me',null,401],['/api/auth/me',customer,200],
  ['/api/bookings/mine',customer,200],['/api/wallet/subscriptions/mine',customer,200],
  ['/api/health/health-profile',customer,environment==='dev'?200:404],
  ...['activation?days=30','known-events?limit=100','retention?weeks=12','website-traffic?days=30','location-reach?days=30&limit=10','supply-health'].map(r=>['/api/bookings/admin/analytics/'+r,admin,200])]){
  const started=Date.now();const response=await fetch(base+route,{headers:user?{Authorization:'Bearer '+bearer(user)}:{},signal:AbortSignal.timeout(60000)});
  const body=await response.json().catch(()=>null);
  results.push({route:route.split('?')[0],status:response.status,expected,milliseconds:Date.now()-started,passed:response.status===expected&&(expected===404||!!body)});
 }
}finally{await source.end();}
writeFileSync(`docs/analytics-http-${environment}.json`,JSON.stringify({environment,results},null,2)+'\n');
console.log(JSON.stringify({environment,checks:results.length,passed:results.filter(r=>r.passed).length,failures:results.filter(r=>!r.passed)}));
if(results.some(r=>!r.passed))process.exitCode=1;
