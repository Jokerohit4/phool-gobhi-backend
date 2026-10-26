// Writes a private local snapshot for the migration loader. Never prints rows,
// credentials, event properties or actor IDs. Source reads use one RO snapshot.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { Client } = require('pg');
const [environment, output, mode] = process.argv.slice(2);
if (!['dev','prod'].includes(environment) || !output) throw Error('Specify dev|prod and an owned output file');
const keys = 'amount anon_distinct_id app channel city geo_city geo_country granted gym_id landing_path method nearest_gym_distance_km permission reason referrer_host screen_name session_id step surface training_location utm_campaign utm_source'.split(' ');
(async()=>{
  const secrets = JSON.parse(execFileSync(process.platform==='win32'?'gcloud.cmd':'gcloud',
    ['secrets','versions','access','latest',`--secret=auth-service-secrets-${environment}`,'--project=phool-gobhi'],
    {shell:process.platform==='win32',encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const uri = new URL(secrets.ANALYTICS_DATABASE_URL);
  const sourceId = createHash('sha256').update(uri.hostname+':'+(uri.port||'5432')+uri.pathname).digest('hex').slice(0,16);
  const client = new Client({connectionString:uri.toString(),connectionTimeoutMillis:10000,query_timeout:30000});
  try {
    await client.connect();
    if(mode==='--prepare-dual') {
      await client.query("SET lock_timeout='3s'");
      await client.query('ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS event_id TEXT');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_delivery_id ON analytics_events(event_id) WHERE event_id IS NOT NULL');
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const column = (await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='analytics_events' AND column_name='event_id' AND table_schema=current_schema()")).rows[0].n;
    const asOf = (await client.query(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts`)).rows[0].ts;
    const rows = (await client.query(`SELECT id::text,event,distinct_id,properties,source,service,
      to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
      ${column?'event_id':'NULL::text AS event_id'} FROM analytics_events ORDER BY analytics_events.id`)).rows;
    const hash = createHash('sha256');
    const lines = rows.map(row=>{
      hash.update(JSON.stringify(row)+'\n');
      const receipt = row.source==='server' && row.service==='auth-service' &&
        ['explore_pickup_saved','explore_pickup_rejected'].includes(row.event) && row.properties?._delivery_id;
      const value = {event_id:row.event_id || (receipt?'receipt:'+receipt:`legacy:${sourceId}:${row.id}`),
        event:row.event,distinct_id:row.distinct_id,properties:JSON.stringify(row.properties),source:row.source,service:row.service,
        environment,ts:row.ts,ingested_at:asOf,legacy_id:row.id};
      for(const key of keys){const property=row.properties?.[key];value['p_'+key]=property==null||typeof property==='object'?null:String(property);}
      return JSON.stringify(value);
    });
    await client.query('ROLLBACK');
    writeFileSync(output,lines.join('\n')+'\n',{mode:0o600});
    const receipt={environment,sourceId,rows:rows.length,maximumLegacyId:rows.at(-1)?.id||'0',
      earliestTimestamp:rows.reduce((oldest,row)=>row.ts<oldest?row.ts:oldest,asOf),asOf,sourceSha256:hash.digest('hex'),
      sourceReadOnly:true,dualSchemaPrepared:mode==='--prepare-dual'};
    writeFileSync(output+'.receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify(receipt));
  } finally {await client.end();}
})().catch(error=>{console.error(JSON.stringify({environment,failed:true,code:error.code||error.name}));process.exitCode=1;});
