"""Roll out verified analytics-only images, retaining all other service settings.

Usage: python deploy/analytics/rollout.py PRIVATE_SOURCE_DIR dev dual postgres
       python deploy/analytics/rollout.py PRIVATE_SOURCE_DIR dev bigquery bigquery
Optional trailing service names restrict the rollout. Failed health checks restore
that service's previous image and analytics variables; source data is never deleted.
"""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from capture_sources import SERVICES
from provision import Cloud,PROJECT,LOCATION

GCLOUD=shutil.which('gcloud.cmd') or 'gcloud'

def run(args):
    result=subprocess.run([GCLOUD,*args],capture_output=True,text=True,encoding='utf8')
    if result.returncode: raise RuntimeError('gcloud command failed: '+args[0]+' '+args[1])
    return result.stdout

def rollout(api,root,env,provider,read_provider,services):
    if env not in ('dev','prod') or provider not in ('dual','bigquery') or read_provider not in ('postgres','bigquery'): raise RuntimeError('Invalid rollout mode')
    records=json.loads((root/(env+'-builds.json')).read_text())
    # Verify all selected builds before changing any service.
    images={}
    for service in services:
        record=next(r for r in records if r['service']==service+'-'+env)
        build=api.request(f'https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/builds/'+record['buildId'])
        if build['status']!='SUCCESS': raise RuntimeError(service+': build is '+build['status'])
        images[service]=record['imageTag'].split(':')[0]+'@'+build['results']['images'][0]['digest']
    token=run(['auth','print-identity-token']).strip()
    receipts=[]
    for service in services:
        name=service+'-'+env
        resource=f'https://{LOCATION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/services/{name}'
        before=api.request(resource)
        container=before['spec']['template']['spec']['containers'][0]
        variables={'ANALYTICS_PROVIDER':provider,'ANALYTICS_ENVIRONMENT':env,'ANALYTICS_SERVICE_NAME':service,
            'ANALYTICS_TOPIC':f'projects/{PROJECT}/topics/analytics-events-{env}',
            'ANALYTICS_BIGQUERY_PROJECT':PROJECT,'ANALYTICS_BIGQUERY_DATASET':'analytics_'+env,
            'ANALYTICS_BIGQUERY_LOCATION':LOCATION,'ANALYTICS_MAX_BYTES_BILLED':'268435456'}
        if service=='booking-service': variables['ANALYTICS_READ_PROVIDER']=read_provider
        secret=api.request(f'https://secretmanager.googleapis.com/v1/projects/{PROJECT}/secrets/{service}-secrets-{env}/versions/latest:access')
        keys=set(json.loads(base64.b64decode(secret['payload']['data'])))
        if keys.intersection(variables): raise RuntimeError(name+': secret overrides analytics configuration; reconcile first')
        traffic=before['status'].get('traffic',[])
        if sum(t.get('percent',0)>0 for t in traffic)!=1: raise RuntimeError(name+': unexpected traffic split')
        backup=root/(name+'-before-'+provider+'-'+read_provider+'.json')
        if not backup.exists(): backup.write_text(json.dumps(before,indent=2))
        args=['run','services','update',name,'--project='+PROJECT,'--region='+LOCATION,'--quiet','--format=json']
        try:
            run(args+['--image='+images[service],'--update-env-vars='+','.join(k+'='+v for k,v in variables.items())])
            after=api.request(resource)
            health=after['status']['url']+'/health'
            healthy=False
            for _ in range(4):
                try:
                    with urlopen(Request(health,headers={'Authorization':'Bearer '+token}),timeout=20) as response:
                        healthy=response.status==200
                except (HTTPError,TimeoutError): healthy=False
                if healthy: break
                time.sleep(2)
            if not healthy: raise RuntimeError(name+': post-deploy health check failed')
            current=after['spec']['template']['spec']['containers'][0]
            plain={v['name']:v.get('value') for v in current.get('env',[])}
            if any(plain.get(k)!=v for k,v in variables.items()): raise RuntimeError(name+': deployed analytics configuration mismatch')
            if current['image']!=images[service]: raise RuntimeError(name+': image mismatch')
            if after['spec']['template']['spec']['serviceAccountName']!=before['spec']['template']['spec']['serviceAccountName']: raise RuntimeError(name+': runtime identity changed')
            receipt={'service':name,'provider':provider,'readProvider':read_provider if service=='booking-service' else None,
                'revision':after['status']['latestReadyRevisionName'],'image':images[service],'health':200}
            receipts.append(receipt);print(json.dumps(receipt),flush=True)
        except Exception:
            old={v['name']:v.get('value') for v in container.get('env',[]) if 'value' in v}
            restore={k:old[k] for k in variables if k in old}
            remove=[k for k in variables if k not in old]
            rollback=args+['--image='+container['image']]
            if restore: rollback+=['--update-env-vars='+','.join(k+'='+v for k,v in restore.items())]
            if remove: rollback+=['--remove-env-vars='+','.join(remove)]
            run(rollback)
            raise
        finally:
            (root/(env+'-rollout-'+provider+'-'+read_provider+'.json')).write_text(json.dumps(receipts,indent=2))

if __name__=='__main__': rollout(Cloud(),Path(sys.argv[1]),sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5:] or SERVICES)
