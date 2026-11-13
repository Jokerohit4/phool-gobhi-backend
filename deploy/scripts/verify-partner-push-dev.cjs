// Dev-only live token lifecycle probe. Creates and removes two synthetic accounts.
// No real device tokens, SMS, notifications or payments are used.
const {execFileSync}=require('node:child_process');
const {createHmac,randomUUID}=require('node:crypto');
const {createRequire}=require('node:module');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const {Client}=createRequire(path.join(root,'package.json'))('pg');
const BASE='https://gateway-dev-1077801427223.asia-south1.run.app';
const marker='partner-release-probe-'+randomUUID();
const report={environment:'dev',marker,checks:[],cleanedUp:false};
let client;const ids=[];
function check(name,condition){report.checks.push({name,passed:!!condition});if(!condition)throw Error('Check failed: '+name);}
async function main(){
 const secret=JSON.parse(execFileSync('gcloud.cmd',['secrets','versions','access','latest','--secret=auth-service-secrets-dev','--project=phool-gobhi'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 client=new Client({connectionString:secret.DATABASE_URL});await client.connect();
 for(const suffix of ['a','b']){
  const email=marker+'-'+suffix+'@dev.phoolgobhi.invalid';
  const result=await client.query('INSERT INTO auth."User" (name,email,role,type,"isActive","createdAt","updatedAt") VALUES ($1,$2,\'partner\',\'general\',true,now(),now()) RETURNING id',[marker+' '+suffix,email]);
  ids.push(result.rows[0].id);
 }
 function tokenFor(id){const now=Math.floor(Date.now()/1000);const enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const body=enc({alg:'HS256',typ:'JWT'})+'.'+enc({id,role:'partner',type:'general',iat:now,exp:now+600});return body+'.'+createHmac('sha256',secret.JWT_SECRET).update(body).digest('base64url');}
 async function api(method,token,body){const res=await fetch(BASE+'/api/auth/fcm-token',{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const data=await res.json().catch(()=>({}));return {status:res.status,ok:data.ok,error:data.error};}
 async function stored(id){return (await client.query('SELECT "fcmToken" FROM auth."User" WHERE id=$1',[id])).rows[0].fcmToken;}
 const [a,b]=ids;const at=tokenFor(a),bt=tokenFor(b);const one=marker+':old',two=marker+':new';
 check('unauthenticated bind rejected',(await api('POST',null,{fcmToken:one})).status===401);
 check('unauthenticated unregister rejected',(await api('DELETE',null,{fcmToken:one})).status===401);
 check('bind token for A',(await api('POST',at,{fcmToken:one})).status===200&&await stored(a)===one);
 check('rebind shared token for B',(await api('POST',bt,{fcmToken:one})).status===200&&await stored(a)===''&&await stored(b)===one);
 check('A cannot remove B registration',(await api('DELETE',at,{fcmToken:one,userId:b})).status===200&&await stored(b)===one);
 check('rotate B token',(await api('POST',bt,{fcmToken:two})).status===200&&await stored(b)===two);
 check('stale unregister preserves rotated token',(await api('DELETE',bt,{fcmToken:one})).status===200&&await stored(b)===two);
 check('matching unregister clears nonnullable column',(await api('DELETE',bt,{fcmToken:two})).status===200&&await stored(b)==='');
 check('malformed token rejected',(await api('POST',bt,{fcmToken:{invalid:true}})).status===400);
}
main().catch(error=>{report.error=error.message;process.exitCode=1;}).finally(async()=>{
 if(client){try{if(ids.length)await client.query('DELETE FROM auth."User" WHERE id=ANY($1::int[]) AND email LIKE $2',[ids,marker+'%@dev.phoolgobhi.invalid']);report.cleanedUp=true;}catch(error){report.cleanupError=error.message;process.exitCode=1;}await client.end();}
 fs.writeFileSync(path.join(root,'../phool-gobhi-partner-app/.dart_tool/partner-push-dev-verification.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
});
