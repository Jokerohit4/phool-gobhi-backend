import { randomUUID } from 'node:crypto';
import { parseOccurrence } from './contracts.js';

// Explicit projection: never spread a command, receipt, proof or catalogue item.
export function pickupProperties({command, receipt, reason}) {
  if (reason) return {source:'location', occurrence_kind:parseOccurrence(command.occurrenceId)?'grid':null, reason};
  const seconds=(Date.parse(receipt.completedAt)-Date.parse(receipt.startedAt))/1000;
  const duration_bucket=seconds<10?'under_10s':seconds<60?'10s_to_1m':seconds<300?'1m_to_5m':seconds<900?'5m_to_15m':'15m_plus';
  return {source:'location', occurrence_kind:'grid', duration_bucket};
}

export async function enqueuePickupOutcome(tx,{userId,command,receipt,reason,receivedAt}) {
  await tx.exploreReceiptEvent.create({data:{
    eventId:randomUUID(), userId,
    receiptId:receipt?.receiptId??null, claimId:reason?command.claimId:null,
    event:reason?'explore_pickup_rejected':'explore_pickup_saved',
    properties:pickupProperties({command,receipt,reason}),
    createdAt:new Date(receivedAt), nextAttemptAt:new Date(receivedAt), attempts:0,
  }});
}

// Row locks serialize replicas and coordinate with account deletion's first delete.
// A crash after sink COMMIT leaves this row pending; the sink must deduplicate.
export async function deliverPickupBatch({db,send,limit=25,now=()=>new Date()}) {
  let delivered=0;
  for(let i=0;i<limit;i++) {
    const outcome=await db.$transaction(async tx=>{
      const [row]=await tx.$queryRaw`SELECT * FROM "auth"."ExploreReceiptEvent"
        WHERE "deliveredAt" IS NULL AND "nextAttemptAt" <= NOW()
        ORDER BY "nextAttemptAt", "eventId" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!row) return 'empty';
      try {
        await send(row);
      } catch {
        // No error text or payload is persisted/logged. Bound backoff to one hour.
        await tx.exploreReceiptEvent.update({where:{eventId:row.eventId},data:{attempts:row.attempts+1,nextAttemptAt:new Date(now().getTime()+Math.min(3600000,1000*2**Math.min(row.attempts,12)))}});
        return 'retry';
      }
      await tx.exploreReceiptEvent.update({where:{eventId:row.eventId},data:{deliveredAt:now(),attempts:row.attempts+1}});
      return 'delivered';
    },{timeout:15000});
    if(outcome==='empty') break;
    if(outcome==='delivered') delivered++;
  }
  return delivered;
}

export function startPickupDelivery({db,send,intervalMs=15000}) {
  let running=false;
  const tick=async()=>{
    if(running) return;
    running=true;
    try { await deliverPickupBatch({db,send}); }
    catch { console.error('[explore telemetry] delivery deferred'); }
    finally { running=false; }
  };
  const timer=setInterval(tick,intervalMs);
  timer.unref();
  void tick();
  return ()=>clearInterval(timer);
}
