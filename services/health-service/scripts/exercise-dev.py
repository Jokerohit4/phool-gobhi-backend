"""Run the exercise dev audit/backfill with captured dev-only credentials.

No secret values are printed or written to disk. Production is not supported.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CLOUD = shutil.which('gcloud.cmd') or shutil.which('gcloud')


def cloud(*args):
    result = subprocess.run([CLOUD, *args, '--project=phool-gobhi'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Dev cloud operation failed; no credential output disclosed')
    return result.stdout


def main():
    action = sys.argv[1] if len(sys.argv) in {2, 3} else None
    if action not in {'audit', 'apply', 'verify'}:
        raise RuntimeError('Usage: python scripts/exercise-dev.py audit|apply|verify (dev only)')
    service = json.loads(cloud('run', 'services', 'describe', 'health-service-dev', '--region=asia-south1', '--format=json'))
    entries = service['spec']['template']['spec']['containers'][0].get('env', [])
    ref = next(e['valueFrom']['secretKeyRef'] for e in entries if e['name'] == 'SECRETS_JSON')
    if not ref['name'].endswith('-dev'):
        raise RuntimeError('Refusing non-dev secret binding')
    secrets = json.loads(cloud('secrets', 'versions', 'access', ref['key'], '--secret=' + ref['name']))
    environment = os.environ.copy()
    environment['DATABASE_URL'] = secrets['DATABASE_URL']
    environment['EXERCISE_DEV_TARGET'] = 'health-service-dev'
    if action == 'verify':
        url = sys.argv[2] if len(sys.argv) == 3 else service['status']['url']
        if url != service['status']['url'] and not url.endswith('---' + service['status']['url'].removeprefix('https://')):
            raise RuntimeError('Verification URL must belong to health-service-dev')
        environment['EXERCISE_DEV_URL'] = url
        environment['EXERCISE_DEV_IDENTITY_TOKEN'] = cloud('auth', 'print-identity-token').strip()
    result = subprocess.run(['node', 'scripts/exerciseDevData.mjs', action], cwd=ROOT, env=environment)
    sys.exit(result.returncode)


if __name__ == '__main__':
    main()
