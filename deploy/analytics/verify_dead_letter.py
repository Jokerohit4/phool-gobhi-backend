"""Prove malformed-row quarantine on temporary resources; no live backlog is pulled."""
import base64,json,time,uuid
from pathlib import Path
from provision import Cloud,PROJECT,NUMBER,LOCATION
from grant_runtime import binding

def verify(api):
    suffix=uuid.uuid4().hex[:10]
    topic='analytics-quarantine-probe-'+suffix
    dead=topic+'-dead'
    export=topic+'-export';pull=topic+'-pull'
    base=f'https://pubsub.googleapis.com/v1/projects/{PROJECT}'
    agent=f'serviceAccount:service-{NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com'
    created=[]
    try:
        for name in (topic,dead):
            api.request(base+'/topics/'+name,'PUT',{'messageStoragePolicy':{'allowedPersistenceRegions':[LOCATION]}})
            created.append(('topics',name))
        api.request(base+'/subscriptions/'+pull,'PUT',{'topic':f'projects/{PROJECT}/topics/{dead}','expirationPolicy':{}})
        created.append(('subscriptions',pull))
        api.request(base+'/subscriptions/'+export,'PUT',{'topic':f'projects/{PROJECT}/topics/{topic}',
            'bigqueryConfig':{'table':f'{PROJECT}.analytics_dev.events_raw','useTableSchema':True,'dropUnknownFields':False},
            'deadLetterPolicy':{'deadLetterTopic':f'projects/{PROJECT}/topics/{dead}','maxDeliveryAttempts':5},
            'retryPolicy':{'minimumBackoff':'0s','maximumBackoff':'10s'},'ackDeadlineSeconds':10,'expirationPolicy':{}})
        created.append(('subscriptions',export))
        binding(api,base+'/topics/'+dead,'roles/pubsub.publisher',agent)
        binding(api,base+'/subscriptions/'+export,'roles/pubsub.subscriber',agent)
        payload=base64.b64encode(json.dumps({'invalid_warehouse_probe':suffix}).encode()).decode()
        api.request(base+'/topics/'+topic+':publish','POST',{'messages':[{'data':payload}]})
        passed=False
        for _ in range(120):
            result=api.request(base+'/subscriptions/'+pull+':pull','POST',{'maxMessages':1,'returnImmediately':True})
            messages=result.get('receivedMessages',[])
            if messages:
                if messages[0]['message']['data']!=payload: raise RuntimeError('Unexpected probe quarantine payload')
                api.request(base+'/subscriptions/'+pull+':acknowledge','POST',{'ackIds':[messages[0]['ackId']]})
                passed=True;break
            time.sleep(2)
        if not passed: raise RuntimeError('Malformed message did not reach quarantine within deadline')
        receipt={'malformedRowQuarantined':True,'originalPayloadPreserved':True,'temporaryResourcesRemoved':False,'passed':True}
    finally:
        for kind,name in sorted(created,key=lambda x:x[0]!='subscriptions'):
            api.request(base+'/'+kind+'/'+name,'DELETE',allow_missing=True)
    receipt['temporaryResourcesRemoved']=True
    Path('docs/analytics-dead-letter-probe.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))

if __name__=='__main__': verify(Cloud())
