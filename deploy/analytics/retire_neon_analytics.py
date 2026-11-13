"""Suspend only the verified dedicated legacy analytics endpoint after cutover.

All runtime providers and operational secret URLs are checked first. Source data
is retained. Dev's shared transactional compute is never changed.
"""
import base64
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlparse,urlencode
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from provision import Cloud,PROJECT,LOCATION
from capture_sources import SERVICES

NEON_PROJECT='royal-dream-75131677'
ENDPOINT='ep-dry-dawn-azk2yq66'

def retire(api):
    current=json.loads(Path('docs/analytics-backfill-prod-receipt.json').read_text())
    previous=json.loads(subprocess.check_output(['git','show','HEAD:docs/analytics-backfill-prod-receipt.json'],text=True))
    gap=(datetime.fromisoformat(current['asOf'].replace('Z','+00:00'))-datetime.fromisoformat(previous['asOf'].replace('Z','+00:00'))).total_seconds()
    if not current.get('warehouseContentMatched') or current['sourceSha256']!=previous['sourceSha256'] or gap<60:
        raise RuntimeError('Two reconciled, unchanged production source snapshots at least one minute apart are required')
    analytics_references=0
    preserved_dev_validation_tags=[]
    for env in ('dev','prod'):
        for service in SERVICES:
            name=service+'-'+env
            live=api.request(f'https://{LOCATION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/services/{name}')
            container=live['spec']['template']['spec']['containers'][0]
            variables={v['name']:v.get('value') for v in container.get('env',[])}
            if variables.get('ANALYTICS_PROVIDER')!='bigquery': raise RuntimeError(name+': legacy writer remains')
            if service=='booking-service' and variables.get('ANALYTICS_READ_PROVIDER')!='bigquery': raise RuntimeError(name+': legacy reader remains')
            for target in live['status'].get('traffic',[]):
                if target.get('tag') and target.get('revisionName')!=live['status']['latestReadyRevisionName']:
                    if env=='prod' or target.get('percent',0):
                        raise RuntimeError(name+': a legacy revision still has serving/production traffic')
                    # This pre-existing, zero-traffic QA revision uses dev's
                    # transactional DB. Preserve its separate feature validation.
                    preserved_dev_validation_tags.append({'service':name,'tag':target['tag'],'percent':0})
            secret_name=f'{service}-secrets-{env}'
            secret=api.request(f'https://secretmanager.googleapis.com/v1/projects/{PROJECT}/secrets/{secret_name}/versions/latest:access')
            values=json.loads(base64.b64decode(secret['payload']['data']))
            for key,value in values.items():
                if not isinstance(value,str) or not value.startswith(('postgres://','postgresql://')): continue
                host=urlparse(value).hostname or ''
                endpoint=host.split('.')[0].removesuffix('-pooler')
                if endpoint==ENDPOINT:
                    if key!='ANALYTICS_DATABASE_URL' or env!='prod': raise RuntimeError('Dedicated endpoint is used by an operational database')
                    analytics_references+=1
    if analytics_references!=8: raise RuntimeError('Unexpected dedicated endpoint reference inventory')
    credential_path=Path.home()/'.config/neonctl/credentials.json'
    credentials=json.loads(credential_path.read_text())
    def refresh():
        with urlopen('https://oauth2.neon.tech/.well-known/openid-configuration',timeout=20) as response:
            discovery=json.load(response)
        endpoint=discovery['token_endpoint']
        if urlparse(endpoint).scheme!='https' or urlparse(endpoint).hostname!='oauth2.neon.tech': raise RuntimeError('Unexpected Neon OAuth endpoint')
        body=urlencode({'grant_type':'refresh_token','refresh_token':credentials['refresh_token'],'client_id':'neonctl'}).encode()
        with urlopen(Request(endpoint,data=body),timeout=20) as response:
            updated=json.load(response)
        # Save a rotating refresh token before making any further API request.
        credentials.update(updated)
        credentials['expires_at']=int(time.time()*1000)+updated.get('expires_in',3600)*1000
        temporary=credential_path.with_suffix('.refreshing.json')
        temporary.write_text(json.dumps(credentials),encoding='utf8')
        temporary.replace(credential_path)
    if credentials.get('expires_at',0)<int(time.time()*1000)+30000: refresh()
    def neon(path,method='GET',data=None):
        request=Request('https://console.neon.tech/api/v2'+path,method=method,
            headers={'Authorization':'Bearer '+credentials['access_token'],'Content-Type':'application/json'},
            data=None if data is None else json.dumps(data).encode())
        try:
            with urlopen(request,timeout=30) as response:return json.load(response)
        except HTTPError as error:
            if error.code!=401: raise
            refresh()
            request.add_header('Authorization','Bearer '+credentials['access_token'])
            with urlopen(request,timeout=30) as response:return json.load(response)
    resource=f'/projects/{NEON_PROJECT}/endpoints/{ENDPOINT}'
    before=neon(resource)['endpoint']
    # Zero is Neon's five-minute default, including Free projects where custom
    # timeout changes are rejected. Do not request a paid feature to set it.
    timeout=before['suspend_timeout_seconds']
    if timeout==-1 or timeout>300:
        neon(resource,'PATCH',{'endpoint':{'suspend_timeout_seconds':300}})
    for _ in range(40):
        state=neon(resource)['endpoint']
        if state['current_state'] in ('idle','active'): break
        time.sleep(1)
    if state['current_state']!='idle': neon(resource+'/suspend','POST')
    for _ in range(60):
        state=neon(resource)['endpoint']
        if state['current_state']=='idle': break
        time.sleep(1)
    if state['current_state']!='idle': raise RuntimeError('Legacy analytics endpoint did not become idle')
    receipt={'project':NEON_PROJECT,'endpoint':ENDPOINT,'state':state['current_state'],
        'suspendTimeoutSeconds':state['suspend_timeout_seconds'],'operationalReferences':0,
        'effectiveSuspendTimeoutSeconds':state['suspend_timeout_seconds'] or 300,
        'legacyAnalyticsReferences':analytics_references,'runtimeProvidersVerified':16,
        'preservedZeroTrafficDevValidationTags':preserved_dev_validation_tags,
        'unchangedSourceSnapshotSeconds':gap,'sourceDataRetained':True,'devTransactionalComputeChanged':False,'passed':True}
    Path('docs/analytics-neon-retirement.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))

if __name__=='__main__': retire(Cloud())
