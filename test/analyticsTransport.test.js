import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { analyticsMiddleware, enqueueWarehouse, eventEnvelope, publishRows } from '../utils/analyticsTransport.js';

test('warehouse envelopes preserve identity and time while omitting unused raw identifiers', () => {
  process.env.ANALYTICS_ENVIRONMENT='dev';
  const row=eventEnvelope({event:'screen_viewed',distinctId:7,eventId:'stable-id',timestamp:'2026-10-01T00:00:00Z',
    properties:{app:'website',gym_id:1,granted:true,ip:'private-ip',user_agent:'private-agent'}});
  assert.equal(row.event_id,'stable-id');assert.equal(row.distinct_id,'7');
  assert.equal(row.ts,'2026-10-01T00:00:00.000Z');assert.equal(row.p_gym_id,'1');assert.equal(row.p_granted,'true');
  assert.ok(!('ip' in JSON.parse(row.properties)));assert.ok(!('user_agent' in JSON.parse(row.properties)));
});

test('publish retries retain event IDs and refuse cross-environment topics',async()=>{
  process.env.ANALYTICS_ENVIRONMENT='dev';
  const calls=[];const client={async request(options){calls.push(options.data);if(calls.length===1)throw Error('temporary');return {data:{messageIds:['ack']}};}};
  await publishRows([eventEnvelope({event:'screen_viewed',eventId:'stable'})],{client,topic:'projects/phool-gobhi/topics/analytics-events-dev'});
  assert.deepEqual(calls[0],calls[1]);
  await assert.rejects(publishRows([{}],{client,topic:'projects/phool-gobhi/topics/analytics-events-prod'}),/mismatch/);
  assert.equal(calls.length,2);
});

test('request batches are isolated and a client acceptance waits for the durable acknowledgement',async t=>{
  process.env.ANALYTICS_PROVIDER='bigquery';process.env.ANALYTICS_ENVIRONMENT='dev';
  const batches=[];let release;const gate=new Promise(resolve=>{release=resolve;});
  const app=express();
  app.use(analyticsMiddleware({publish:async rows=>{batches.push(rows);if(rows[0]?.event==='slow')await gate;}}));
  app.get('/:event',(req,res)=>{enqueueWarehouse(eventEnvelope({event:req.params.event}));res.status(202).json({ok:true});});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  let completed=false;const slow=fetch(base+'/slow').then(response=>{completed=true;return response;});
  const fast=await fetch(base+'/fast');assert.equal(fast.status,202);assert.equal(completed,false);
  release();assert.equal((await slow).status,202);
  assert.deepEqual(batches.map(batch=>batch.map(row=>row.event)).sort(),[['fast'],['slow']]);
  delete process.env.ANALYTICS_PROVIDER;
});

test('failed client delivery returns retryable 503 without failing a business response',async t=>{
  process.env.ANALYTICS_PROVIDER='bigquery';process.env.ANALYTICS_ENVIRONMENT='dev';
  t.mock.method(console,'error',()=>{});
  const app=express();app.use(analyticsMiddleware({publish:async()=>{throw Error('private provider error');}}));
  for(const route of ['/api/events','/booking'])app.get(route,(_req,res)=>{enqueueWarehouse(eventEnvelope({event:'screen_viewed'}));res.status(202).json({ok:true});});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const client=await fetch(base+'/api/events');assert.equal(client.status,503);assert.equal((await client.json()).retryable,true);
  assert.equal((await fetch(base+'/booking')).status,202);
  delete process.env.ANALYTICS_PROVIDER;
});
