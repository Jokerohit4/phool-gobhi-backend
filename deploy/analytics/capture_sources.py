"""Capture exact deployed build sources into a private temporary directory.

Only aggregate identities are printed; service environment values stay in the
local rollback file. Source provenance must match the deployed image digest.
"""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import tarfile
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
import zipfile
from provision import Cloud, PROJECT, LOCATION

SERVICES = ['gateway','auth-service','gym-service','wallet-service','booking-service','buddy-service','challenge-service','health-service']

def capture(api, environment, root, services=SERVICES):
    receipts=[]
    for service in services:
        if service not in SERVICES: raise RuntimeError('Unknown service')
        name=f'{service}-{environment}'
        live=api.request(f'https://{LOCATION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/services/{name}')
        annotations=live['metadata']['annotations']
        image=live['spec']['template']['spec']['containers'][0]['image']
        digest=image.split('@')[-1]
        build=api.request('https://cloudbuild.googleapis.com/v1/'+annotations['run.googleapis.com/build-name'])
        if digest not in [i['digest'] for i in build.get('results',{}).get('images',[])]:
            # An image-only migration retains the original Run build annotation.
            # Accept only the exact immutable image/build pair in its receipt.
            receipt_path=Path(__file__).resolve().parents[2]/'docs/analytics-deployment-receipt.json'
            deployment=json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
            record=next((r for r in deployment.get('services',[]) if r['service']==name and r['image']==image),None)
            if not record: raise RuntimeError(f'{name}: build provenance does not match deployed digest')
            build=api.request(f'https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/builds/'+record['buildId'])
            if digest not in [i['digest'] for i in build.get('results',{}).get('images',[])]:
                raise RuntimeError(f'{name}: migration receipt provenance mismatch')
        source=build['sourceProvenance']['resolvedStorageSource']
        url=f'https://storage.googleapis.com/storage/v1/b/{source["bucket"]}/o/{quote(source["object"],safe="")}?alt=media&generation={source["generation"]}'
        with urlopen(Request(url,headers={'Authorization':'Bearer '+api.token}),timeout=90) as response:
            archive=response.read()
        target=root/name
        target.mkdir()
        if zipfile.is_zipfile(io.BytesIO(archive)):
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                for member in z.infolist():
                    path=(target/member.filename).resolve()
                    if not path.is_relative_to(target.resolve()): raise RuntimeError('unsafe source archive path')
                    if member.external_attr >> 16 & 0o170000 == 0o120000: raise RuntimeError('source archive symlink')
                z.extractall(target)
        else:
            with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as t:
                for member in t.getmembers():
                    path=(target/member.name).resolve()
                    if not path.is_relative_to(target.resolve()) or member.issym() or member.islnk(): raise RuntimeError('unsafe source tar member')
                t.extractall(target,filter='data')
        (root/(name+'-rollback.json')).write_text(json.dumps(live,indent=2))
        package=json.loads((target/'package.json').read_text())
        receipts.append({'service':name,'image':image,'sourceArchiveSha256':hashlib.sha256(archive).hexdigest(),
            'googleAuth':package.get('dependencies',{}).get('google-auth-library'),
            'entry': 'index.js' if service=='gateway' else 'app.js',
            'files':len(list(target.rglob('*'))),
            'source':source})
        print(json.dumps(receipts[-1]),flush=True)
    (root/(environment+'-provenance.json')).write_text(json.dumps(receipts,indent=2))

if __name__=='__main__':
    import sys
    environment=sys.argv[1]
    if environment not in ('dev','prod'): raise RuntimeError('specify dev or prod')
    root=Path(tempfile.mkdtemp(prefix='analytics-deployed-sources-'))
    print(json.dumps({'privateWorkingDirectory':str(root)}),flush=True)
    capture(Cloud(),environment,root,sys.argv[2:] or SERVICES)
