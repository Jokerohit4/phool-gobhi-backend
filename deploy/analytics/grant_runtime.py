"""Grant existing runtime identities topic publishing and booking-only reads."""
from provision import Cloud, PROJECT, LOCATION
from capture_sources import SERVICES
import json

def binding(api,resource,role,member):
    policy=api.request(resource+':getIamPolicy', 'GET' if 'pubsub.googleapis.com' in resource else 'POST', None if 'pubsub.googleapis.com' in resource else {})
    bindings=policy.setdefault('bindings',[])
    entry=next((b for b in bindings if b['role']==role and not b.get('condition')),None)
    if entry is None:
        entry={'role':role,'members':[]};bindings.append(entry)
    if member not in entry['members']:
        entry['members'].append(member)
        api.request(resource+':setIamPolicy','POST',{'policy':policy})

def grant(api):
    for env in ('dev','prod'):
        writers=set()
        for service in SERVICES:
            live=api.request(f'https://{LOCATION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/services/{service}-{env}')
            account=live['spec']['template']['spec']['serviceAccountName']
            writers.add(account)
            if service=='booking-service': reader=account
        for account in writers:
            binding(api,f'https://pubsub.googleapis.com/v1/projects/{PROJECT}/topics/analytics-events-{env}',
                'roles/pubsub.publisher','serviceAccount:'+account)
        binding(api,f'https://cloudresourcemanager.googleapis.com/v1/projects/{PROJECT}',
            'roles/bigquery.jobUser','serviceAccount:'+reader)
        resource=f'https://bigquery.googleapis.com/bigquery/v2/projects/{PROJECT}/datasets/analytics_{env}'
        dataset=api.request(resource)
        access=dataset.get('access',[])
        if not any(a.get('userByEmail')==reader and a.get('role') in ('READER','WRITER','OWNER') for a in access):
            access.append({'role':'READER','userByEmail':reader})
            api.request(resource,'PATCH',{'access':access})
        print(json.dumps({'environment':env,'publishers':sorted(writers),'reader':reader}),flush=True)

if __name__=='__main__': grant(Cloud())
