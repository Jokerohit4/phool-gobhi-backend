"""Patch proven deployed sources, never replace production with dev features."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from capture_sources import SERVICES

REPO=Path(__file__).resolve().parents[2]

def patch(root,env):
    receipts=[]
    for service in SERVICES:
        target=root/f'{service}-{env}'
        before={p.relative_to(target).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob('*') if p.is_file()}
        for name in ('analyticsTransport.js','bigQueryAnalytics.js'):
            shutil.copyfile(REPO/'utils'/name,target/'utils'/name)
        # Preserve the first-party-only diagnostic guard even on older images
        # which do not know these events/routes yet.
        auth=service=='auth-service'
        facade="import { createAnalytics } from './analyticsTransport.js';\n"
        facade+="const analytics=createAnalytics({protectedEvents:new Set(['explore_pickup_queue_issue','explore_pickup_queue_resolved'])});\n" if service=='gateway' else 'const analytics=createAnalytics();\n'
        facade+='export const track=analytics.track;\nexport const ingest=analytics.ingest;\n'
        if auth: facade+='export const deliverReceiptEvent=analytics.deliverReceiptEvent;\nexport { insertReceiptEvent } from "./analyticsTransport.js";\n'
        facade+='export default {track,ingest};\n'
        (target/'utils/analytics.js').write_text(facade)
        entry=target/('index.js' if service=='gateway' else 'app.js')
        text=entry.read_text(encoding='utf8')
        anchor="import './bootstrap-secrets.js';"
        if anchor not in text: raise RuntimeError('bootstrap order must be reviewed: '+service)
        if 'import { analyticsMiddleware }' not in text:
            text=text.replace(anchor,anchor+"\nimport { analyticsMiddleware } from './utils/analyticsTransport.js';",1)
        if auth and 'startPickupDelivery' in text:
            text=text.replace('import { startPickupDelivery }','import { startPickupDelivery, deliverPickupBatch }')
            middleware='app.use(analyticsMiddleware({beforeDrain:()=>deliverPickupBatch({db:prisma,send:deliverReceiptEvent,limit:1})}));'
        else: middleware='app.use(analyticsMiddleware());'
        if 'app.use(analyticsMiddleware(' not in text:
            text,count=re.subn(r'((?:const|export const) app = express\(\);)',lambda m:m[1]+'\n'+middleware,text,count=1)
            if count!=1: raise RuntimeError('express entry shape must be reviewed: '+service)
        if service=='gateway' and 'const eventId = e.event_id' not in text:
            text=text.replace(anchor,anchor+"\nimport { createHash } from 'node:crypto';",1)
            anchor="      if (properties != null && (typeof properties !== 'object' || Array.isArray(properties))) continue;"
            if anchor not in text: raise RuntimeError('gateway ingestion shape requires review')
            text=text.replace(anchor,anchor+"\n      if (e.event_id !== undefined && (typeof e.event_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.event_id))) continue;\n      const occurrence = typeof e.occurred_at === 'string' ? Date.parse(e.occurred_at) : NaN;\n      if (e.event_id !== undefined && (!Number.isFinite(occurrence) || occurrence > Date.now()+300000 || occurrence < Date.now()-7*86400000)) continue;\n      const eventId = e.event_id ? 'client:' + createHash('sha256').update(JSON.stringify([e.distinct_id,e.event,e.event_id])).digest('hex') : undefined;")
            text=text.replace("source: 'client' });","source: 'client', ...(eventId ? {eventId,timestamp:e.occurred_at} : {}) });")
        entry.write_text(text,encoding='utf8')
        if service=='booking-service':
            path=target/'services/analyticsQueryService.js'
            text=path.read_text(encoding='utf8')
            if 'import { queryBigQuery }' not in text:
                text="import { queryBigQuery } from '../utils/bigQueryAnalytics.js';\n"+text
                text=text.replace('async function query(sql, params = []) {',"async function query(sql, params = []) {\n  if (process.env.ANALYTICS_READ_PROVIDER === 'bigquery') return queryBigQuery(sql,params);",1)
            path.write_text(text,encoding='utf8')
        after={p.relative_to(target).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob('*') if p.is_file()}
        changed=sorted(k for k,v in after.items() if before.get(k)!=v)
        allowed={entry.name,'utils/analytics.js','utils/analyticsTransport.js','utils/bigQueryAnalytics.js'}
        if service=='booking-service': allowed.add('services/analyticsQueryService.js')
        if not set(changed)<=allowed: raise RuntimeError('unexpected patch surface: '+str(changed))
        receipts.append({'service':service+'-'+env,'changedFiles':changed,'fileSha256':{k:after[k] for k in changed}})
    (root/(env+'-patches.json')).write_text(json.dumps(receipts,indent=2))
    print(json.dumps({'environment':env,'patchedServices':len(receipts),'changedFiles':sum(len(r['changedFiles']) for r in receipts)}))

if __name__=='__main__': patch(Path(sys.argv[1]),sys.argv[2])
