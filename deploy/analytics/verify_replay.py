"""Replay one existing event through Pub/Sub and prove report-level deduplication.

Payload remains in process memory and private cloud services. It is neither logged
nor saved. The source event is preserved unchanged; only ingestion time advances.
"""
import base64,json,time,sys
from datetime import datetime,timezone
from pathlib import Path
from provision import Cloud,PROJECT

def verify(api,env):
    if env not in ('dev','prod'): raise RuntimeError('specify dev or prod')
    table=f'{PROJECT}.analytics_{env}.events_raw'
    selected=api.query(f"SELECT TO_JSON_STRING(t) AS payload FROM `{table}` t WHERE ts BETWEEN TIMESTAMP('2020-01-01') AND CURRENT_TIMESTAMP() AND event_id LIKE 'legacy:%' ORDER BY legacy_id LIMIT 1")
    row=json.loads(selected['rows'][0]['f'][0]['v'])
    row['ingested_at']=datetime.now(timezone.utc).isoformat()
    event_id=row['event_id']
    topic=f'https://pubsub.googleapis.com/v1/projects/{PROJECT}/topics/analytics-events-{env}:publish'
    api.request(topic,'POST',{'messages':[{'data':base64.b64encode(json.dumps(row).encode()).decode()}]})
    for _ in range(60):
        result=api.query(f"SELECT (SELECT COUNT(*) FROM `{table}` WHERE ts BETWEEN TIMESTAMP('2020-01-01') AND CURRENT_TIMESTAMP() AND event_id='{event_id}') AS raw_copies, (SELECT COUNT(*) FROM `{PROJECT}.analytics_{env}.events_between`(TIMESTAMP('2020-01-01'),CURRENT_TIMESTAMP(),ARRAY<STRING>[]) WHERE event_id='{event_id}') AS report_copies")
        raw,visible=[int(f['v']) for f in result['rows'][0]['f']]
        if raw>=2 and visible==1:
            receipt={'environment':env,'existingEventReplayed':True,'rawCopies':raw,'reportCopies':visible,'passed':True,'payloadLogged':False}
            Path(f'docs/analytics-replay-{env}.json').write_text(json.dumps(receipt,indent=2)+'\n')
            print(json.dumps(receipt));return
        time.sleep(2)
    raise RuntimeError('Report deduplication did not pass')

if __name__=='__main__': verify(Cloud(),sys.argv[1])
