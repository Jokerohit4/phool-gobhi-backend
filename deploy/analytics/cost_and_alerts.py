"""Reconcile analytics query quota and operational alerts using existing email channels."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from cloud_health import Monitoring
from provision import Cloud, PROJECT, NUMBER

def configure(api):
    metric='bigquery.googleapis.com/quota/query/usage'
    resource=f'https://serviceusage.googleapis.com/v1beta1/projects/{NUMBER}/services/bigquery.googleapis.com/consumerQuotaMetrics'
    metrics=api.request(resource+'?view=FULL&pageSize=200')['metrics']
    usage=next(m for m in metrics if m['metric']==metric)
    limit=next(l for l in usage['consumerQuotaLimits'] if l['unit']=='1/d/{project}')
    bucket=next(b for b in limit['quotaBuckets'] if not b.get('dimensions'))
    base='https://serviceusage.googleapis.com/v1beta1/'+limit['name']
    overrides=api.request(base+'/consumerOverrides').get('overrides',[])
    old=next((o for o in overrides if not o.get('dimensions')),None)
    if old:
        result=api.request('https://serviceusage.googleapis.com/v1beta1/'+old['name']+'?force=true','PATCH',{'overrideValue':'25600'})
    else:
        result=api.request(base+'/consumerOverrides?force=true','POST',{'overrideValue':'25600'})
    print(json.dumps({'dailyQueryQuotaMiB':25600,'operation':result.get('name'),'approximate':True}),flush=True)
    monitoring=Monitoring()
    channels=[c['name'] for c in monitoring.request('notificationChannels').get('notificationChannels',[]) if c.get('type')=='email' and c.get('enabled',True)]
    if not channels: raise RuntimeError('No existing operations email channel')
    metrics=[
      ('Analytics warehouse backlog older than five minutes','pubsub.googleapis.com/subscription/oldest_unacked_message_age',300,'analytics-events-(dev|prod)-warehouse','180s'),
      ('Analytics dead-letter messages pending','pubsub.googleapis.com/subscription/num_undelivered_messages',0,'analytics-events-(dev|prod)-dead-letter-retained','60s'),
    ]
    for title,metric,value,subscription,duration in metrics:
        condition={'displayName':title,'conditionThreshold':{'filter':f'resource.type="pubsub_subscription" AND metric.type="{metric}" AND resource.labels.subscription_id=monitoring.regex.full_match("{subscription}")',
            'comparison':'COMPARISON_GT','thresholdValue':value,'duration':duration,'trigger':{'count':1},
            'aggregations':[{'alignmentPeriod':'60s','perSeriesAligner':'ALIGN_MAX'}]}}
        monitoring.upsert('alertPolicies',{'displayName':title,'combiner':'OR','enabled':True,'conditions':[condition],
            'notificationChannels':channels,'alertStrategy':{'autoClose':'3600s'},
            'documentation':{'mimeType':'text/markdown','content':'See docs/analytics-bigquery-runbook.md. Preserve dead-letter payloads privately; repair schema/IAM before replaying original event IDs.'},
            'userLabels':{'managed_by':'backend-analytics'}})
    name='analytics_publish_failures'
    metric_resource=f'https://logging.googleapis.com/v2/projects/{PROJECT}/metrics/{name}'
    payload={'name':name,'description':'Count redacted analytics publish failures; never extract identities or payloads.',
        'filter':'resource.type="cloud_run_revision" AND (jsonPayload.code="ANALYTICS_PUBLISH_FAILED" OR textPayload:"ANALYTICS_PUBLISH_FAILED")',
        'metricDescriptor':{'metricKind':'DELTA','valueType':'INT64','unit':'1'}}
    existing=api.request(metric_resource,allow_missing=True)
    api.request(metric_resource if existing else f'https://logging.googleapis.com/v2/projects/{PROJECT}/metrics', 'PUT' if existing else 'POST',payload)
    title='Analytics publishing failures'
    monitoring.upsert('alertPolicies',{'displayName':title,'combiner':'OR','enabled':True,
        'conditions':[{'displayName':title,'conditionThreshold':{
            'filter':f'resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/{name}"',
            'comparison':'COMPARISON_GT','thresholdValue':0,'duration':'0s','trigger':{'count':1},
            'aggregations':[{'alignmentPeriod':'300s','perSeriesAligner':'ALIGN_SUM'}]}}],
        'notificationChannels':channels,'alertStrategy':{'autoClose':'3600s'},'userLabels':{'managed_by':'backend-analytics'}})
    account=api.request(f'https://cloudbilling.googleapis.com/v1/projects/{PROJECT}/billingInfo')['billingAccountName']
    collection='https://billingbudgets.googleapis.com/v1/'+account+'/budgets'
    budgets=api.request(collection+'?pageSize=100').get('budgets',[])
    name='Backend analytics monthly guardrail'
    existing=next((b for b in budgets if b.get('displayName')==name),None)
    payload={'displayName':name,'budgetFilter':{'projects':['projects/'+NUMBER],
        'services':['services/24E6-581D-38E5','services/A1E8-BE35-7EBC'],
        'calendarPeriod':'MONTH','creditTypesTreatment':'EXCLUDE_ALL_CREDITS'},
        'amount':{'specifiedAmount':{'currencyCode':'INR','units':'500'}},
        'thresholdRules':[{'thresholdPercent':fraction,'spendBasis':'CURRENT_SPEND'} for fraction in [.5,.8,1]],
        'notificationsRule':{'monitoringNotificationChannels':channels,'disableDefaultIamRecipients':False}}
    if existing:
        payload['name']=existing['name']
        payload['etag']=existing['etag']
        result=api.request('https://billingbudgets.googleapis.com/v1/'+existing['name'],'PATCH',payload)
    else: result=api.request(collection,'POST',payload)
    print(json.dumps({'budget':result['displayName'],'amount':result['amount'],'thresholds':[.5,.8,1]}),flush=True)

if __name__=='__main__': configure(Cloud())
