"""Capture exact deployed build sources into a private temporary directory.

Only aggregate identities are printed; service environment values stay in the
local rollback file. Source provenance must match the deployed image digest.
"""
import hashlib
import io
import json
from pathlib import Path
import tempfile
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
import zipfile
from provision import Cloud, PROJECT, LOCATION

SERVICES = ['gateway','auth-service','gym-service','wallet-service','booking-service','buddy-service','challenge-service','health-service']

def capture(api, environment, root):
    receipts=[]
    for service in SERVICES:
        name=f'{service}-{environment}'
        live=api.request(f'https://{LOCATION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{PROJECT}/services/{name}')
        annotations=live['metadata']['annotations']
        build=api.request('https://cloudbuild.googleapis.com/v1/'+annotations['run.googleapis.com/build-name'])
        image=live['spec']['template']['spec']['containers'][0]['image']
        digest=image.split('@')[-1]
        if digest not in [i['digest'] for i in build.get('results',{}).get('images',[])]:
            raise RuntimeError(f'{name}: build provenance does not match deployed digest')
        source=build['sourceProvenance']['resolvedStorageSource']
        url=f'https://storage.googleapis.com/storage/v1/b/{source["bucket"]}/o/{quote(source["object"],safe="")}?alt=media&generation={source["generation"]}'
        with urlopen(Request(url,headers={'Authorization':'Bearer '+api.token}),timeout=90) as response:
            archive=response.read()
        target=root/name
        target.mkdir()
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            for member in z.infolist():
                path=(target/member.filename).resolve()
                if not path.is_relative_to(target.resolve()): raise RuntimeError('unsafe source archive path')
                if member.external_attr >> 16 & 0o170000 == 0o120000: raise RuntimeError('source archive symlink')
            z.extractall(target)
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
    capture(Cloud(),environment,root)
