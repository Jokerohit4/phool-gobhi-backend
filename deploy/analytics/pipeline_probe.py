"""Publish duplicate synthetic events with a real runtime identity; check managed delivery.

Probe events are excluded by the report table function. No app account, user
message, credential, or operational database is involved. Temporary jobs are deleted.
"""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from provision import Cloud, PROJECT, LOCATION

def probe(api,root,environment,service):
    builds=json.loads((root/(environment+'-builds.json')).read_text())
    record=next(r for r in builds if r['service']=='gateway-'+environment)
    build=api.request(f'https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/builds/'+record['buildId'])
    if build['status']!='SUCCESS': raise RuntimeError('Probe image build not ready')
    image=record['imageTag'].split(':')[0]+'@'+build['results']['images'][0]['digest']
    live=api.request(f'https://{LOCATION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/services/{service}-{environment}')
    account=live['spec']['template']['spec']['serviceAccountName']
    event_id='pipeline-probe:'+str(uuid.uuid4())
    job='analytics-probe-'+uuid.uuid4().hex[:10]
    env={'ANALYTICS_ENVIRONMENT':environment,'ANALYTICS_TOPIC':f'projects/{PROJECT}/topics/analytics-events-{environment}',
        'ANALYTICS_BIGQUERY_DATASET':'analytics_'+environment,'ANALYTICS_SERVICE_NAME':'migration-probe'}
    script="import {eventEnvelope,publishRows} from './utils/analyticsTransport.js';const row=eventEnvelope({event:'analytics_pipeline_probe',eventId:"+json.dumps(event_id)+"});await publishRows([row,row]);"
    if service=='booking-service':
        script+="const {queryBigQuery}=await import('./utils/bigQueryAnalytics.js');await queryBigQuery('SELECT count(*) AS n FROM analytics_events WHERE event=$1',['analytics_pipeline_probe']);"
    script+="console.log(JSON.stringify({probePassed:true}));"
    base=f'https://run.googleapis.com/v2/projects/{PROJECT}/locations/{LOCATION}/jobs'
    operation=api.request(base+'?jobId='+job,'POST',{'template':{'template':{'serviceAccount':account,'maxRetries':0,'timeout':'60s',
        'containers':[{'image':image,'command':['node'],'args':['--input-type=module','-e',script],
        'env':[{'name':k,'value':v} for k,v in env.items()],
        'resources':{'limits':{'cpu':'1','memory':'512Mi'}}}]}}})
    for _ in range(30):
        status=api.request('https://run.googleapis.com/v2/'+operation['name'])
        if status.get('done'): break
        time.sleep(1)
    if status.get('error') or not status.get('done'): raise RuntimeError('Probe job creation failed')
    execution=api.request(base+'/'+job+':run','POST',{})
    try:
        for _ in range(90):
            status=api.request('https://run.googleapis.com/v2/'+execution['name'])
            if status.get('done'): break
            time.sleep(1)
        if status.get('error') or not status.get('done'): raise RuntimeError('Runtime publishing/reading probe failed: '+job)
        delivered=False
        for _ in range(45):
            result=api.query(f"SELECT count(*) AS copies, count(DISTINCT event_id) AS unique_events FROM `{PROJECT}.analytics_{environment}.events_raw` WHERE ts>=TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 1 DAY) AND event_id='{event_id}'")
            counts=[int(f['v']) for f in result['rows'][0]['f']]
            if counts[0]>=2 and counts[1]==1: delivered=True;break
            time.sleep(2)
        if not delivered: raise RuntimeError('Managed subscription delivery deadline exceeded')
        receipt={'environment':environment,'runtimeAccount':account,'publishedCopies':2,'rawCopies':counts[0],'uniqueEventIds':1,
            'warehouseReadChecked':service=='booking-service','eventId':event_id,'passed':True}
        print(json.dumps(receipt),flush=True)
        path=Path(f'docs/analytics-pipeline-probe-{environment}-{service}.json')
        path.write_text(json.dumps(receipt,indent=2)+'\n')
    finally:
        api.request(base+'/'+job,'DELETE')

if __name__=='__main__': probe(Cloud(),Path(sys.argv[1]),sys.argv[2],sys.argv[3])
