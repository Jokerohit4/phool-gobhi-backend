// CLI queries default to the warehouse. Workload identity/ADC, never a DB fallback.
exports.warehouseClient = async function warehouseClient() {
  const { queryBigQuery, compileAnalyticsQuery } = await import('../utils/bigQueryAnalytics.js');
  const environment=process.env.ANALYTICS_ENVIRONMENT;
  if (!['dev','prod'].includes(environment)) throw Error('Set ANALYTICS_ENVIRONMENT=dev or prod');
  // Operator CLIs use the active gcloud login; apps use workload identity.
  const {execFileSync}=require('node:child_process');
  const token=execFileSync(process.platform==='win32'?'gcloud.cmd':'gcloud',['auth','print-access-token'],{shell:process.platform==='win32',encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const client={async request({url,method='GET',data}) {
    const response=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)});
    const body=await response.json();if(!response.ok)throw Error(body.error?.message || 'Warehouse request failed');return {data:body};
  }};
  return {connect:async()=>{},end:async()=>{},async query(sql,params=[]) {
    if (/to_regclass/.test(sql)) return {rows:[{t:'warehouse.events_raw'}]};
    return queryBigQuery(sql,params,{client});
  },async publish(rows) {
    const {publishRows}=await import('../utils/analyticsTransport.js');
    await publishRows(rows,{client,topic:`projects/phool-gobhi/topics/analytics-events-${environment}`});
  },async native(sql,parameters=[]) {
    const {queryParameters}=compileAnalyticsQuery('SELECT 1',[],{dataset:'analytics_'+environment});
    const table='`phool-gobhi.analytics_'+environment+'.events_between`(@scan_since,@as_of,@event_names)';
    return queryBigQuery(sql.replace(/WAREHOUSE_EVENTS/g,table),[],{native:true,queryParameters:[...queryParameters,...parameters],client});
  }};
};
