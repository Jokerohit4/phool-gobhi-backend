// Read-only BigQuery dry runs of real, parameterized report statements.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { queryBigQuery } from '../../utils/bigQueryAnalytics.js';
const token = execFileSync(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud', ['auth','print-access-token'],
  {shell:process.platform === 'win32',encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const client = {async request({url,method='GET',data}) {
  const response = await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'BigQuery request failed');
  return {data:result};
}};
const fixtures = JSON.parse(readFileSync('tools/analytics/report-queries.json'));
const results = [];
for (let start=0;start<fixtures.length;start+=4) {
  await Promise.all(fixtures.slice(start,start+4).map(async (fixture,index)=>{
    try {
      const result = await queryBigQuery(fixture.sql,fixture.params,{client,dryRun:true,dataset:'analytics_dev'});
      results.push({index:start+index,report:fixture.report,passed:true,estimatedBytes:result.statistics?.query?.totalBytesProcessed || '0'});
    } catch(error) {results.push({index:start+index,report:fixture.report,passed:false,error:error.message});}
  }));
}
results.sort((a,b)=>a.index-b.index);
writeFileSync(process.argv[2] || 'tools/analytics/query-validation.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({queries:results.length,passed:results.filter(r=>r.passed).length,failures:results.filter(r=>!r.passed)}));
if(results.some(result=>!result.passed))process.exitCode=1;
