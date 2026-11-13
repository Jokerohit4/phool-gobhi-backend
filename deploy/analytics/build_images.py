"""Build analytics-only images from provenance-verified patched contexts.

This submits builds; it does not update Cloud Run traffic or environment values.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from capture_sources import SERVICES
from provision import PROJECT, LOCATION

def build(root,environment,services=SERVICES):
    def submit(service):
        context=root/f'{service}-{environment}'
        files=[context/'utils'/f for f in ['analyticsTransport.js','bigQueryAnalytics.js','analytics.js']]
        files.append(context/('index.js' if service=='gateway' else 'app.js'))
        if service=='booking-service': files.append(context/'services/analyticsQueryService.js')
        digest=hashlib.sha256(b''.join(f.read_bytes() for f in files)).hexdigest()[:12]
        image=f'{LOCATION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/{service}-{environment}:bigquery-{digest}'
        result=subprocess.run([shutil.which('gcloud.cmd') or 'gcloud','builds','submit',str(context),
            '--project='+PROJECT,'--region='+LOCATION,'--tag='+image,'--async','--quiet','--format=json'],capture_output=True,text=True,encoding='utf8')
        if result.returncode:
            # gcloud output may describe files; keep details in the private directory.
            (root/(service+'-build-error.log')).write_text(result.stderr,encoding='utf8')
            raise RuntimeError(service+': build submission failed; inspect private log')
        data=json.loads(result.stdout)
        record={'service':service+'-'+environment,'buildId':data['id'],'imageTag':image}
        print(json.dumps(record),flush=True)
        return record
    with ThreadPoolExecutor(max_workers=3) as executor:
        results=list(executor.map(submit,services))
    previous=root/(environment+'-builds.json')
    if previous.exists():
        results+= [r for r in json.loads(previous.read_text()) if r['service'] not in [s+'-'+environment for s in services]]
    (root/(environment+'-builds.json')).write_text(json.dumps(results,indent=2))

if __name__=='__main__': build(Path(sys.argv[1]),sys.argv[2],sys.argv[3:] or SERVICES)
