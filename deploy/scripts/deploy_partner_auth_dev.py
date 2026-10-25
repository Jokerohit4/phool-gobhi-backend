"""Stage, validate and optionally deploy only the partner auth changes to dev.

Run from any directory: python deploy/scripts/deploy_partner_auth_dev.py --deploy
Production is deliberately not a supported argument. No credentials are printed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[2]
SERVICE = 'auth-service'
TARGET = 'auth-service-dev'
PROJECT = 'phool-gobhi'
REGION = 'asia-south1'
SOURCE = Path('services/auth-service')
ADDED = [
    'controllers/pushTokenController.js', 'services/pushTokenService.js',
    'test/pushTokenController.test.js', 'test/pushTokenService.test.js',
]


def run(args, cwd=REPO, capture=False):
    result = subprocess.run(args, cwd=cwd, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        if capture:
            # gcloud diagnostics only; never print a successful token command.
            print(result.stderr.strip())
        raise RuntimeError(f'{Path(args[0]).name} {args[1]} failed ({result.returncode})')
    return result.stdout if capture else ''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deploy', action='store_true')
    args = parser.parse_args()
    git = ['git', '-c', f'safe.directory={REPO.as_posix()}']
    if run(git + ['branch', '--show-current'], capture=True).strip() != 'dev':
        raise RuntimeError('Dev deployment requires the dev checkout.')
    run(['node', 'scripts/check-analytics-events.cjs'])
    run(['node', '--experimental-test-module-mocks', '--test'], cwd=REPO / SOURCE)
    manifest = json.loads((REPO / 'deploy/services.json').read_text(encoding='utf-8'))
    service = manifest['services'][SERVICE]
    if service.get('allowUnauthenticated'):
        raise RuntimeError('Auth-service must remain private.')
    env = service['env']['dev']
    flags = dict(line.split('=', 1) for line in run(
        ['node', 'deploy/scripts/build-deploy-flags.cjs', SERVICE, 'dev'], capture=True
    ).splitlines() if '=' in line)
    staging = Path(tempfile.mkdtemp(prefix='partner-auth-dev-'))
    tracked = run(git + ['ls-files', '-z', '--', SOURCE.as_posix()], capture=True)
    files = {Path(p) for p in tracked.split('\0') if p}
    files.update(SOURCE / p for p in ADDED)
    digest = hashlib.sha256()
    for file in sorted(files):
        origin = REPO / file
        relative = file.relative_to(SOURCE)
        if not origin.is_file():
            continue
        if any(part in {'node_modules', '.git'} for part in relative.parts) or origin.name.startswith('.env'):
            continue
        destination = staging / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin, destination)
        digest.update(relative.as_posix().encode())
        digest.update(origin.read_bytes())
    env_file = staging.parent / (staging.name + '-env.json')
    env_file.write_text(json.dumps(env['plain']), encoding='utf-8')
    record = {'target': TARGET, 'project': PROJECT, 'region': REGION,
              'sourceSha256': digest.hexdigest(), 'sourceDirectory': str(staging),
              'deployed': False}
    report = REPO.parent / 'phool-gobhi-partner-app/.dart_tool/partner-auth-dev-deploy.json'
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(f'Validated and staged auth-service only: {staging}')
    if not args.deploy:
        print('Stage only; pass --deploy to roll out auth-service-dev.')
        return
    cloud = shutil.which('gcloud.cmd') or shutil.which('gcloud')
    if not cloud:
        raise RuntimeError('gcloud is not installed.')
    describe = [cloud, 'run', 'services', 'describe', TARGET, f'--project={PROJECT}',
                f'--region={REGION}', '--format=json(status.url,status.latestReadyRevisionName,status.traffic)']
    try:
        record['before'] = json.loads(run(describe, capture=True))
        secret_refs = ','.join(f'{key}={base}-dev:latest' for key, base in env['secrets'].items())
        run([cloud, 'run', 'deploy', TARGET, '--source=' + str(staging),
             f'--project={PROJECT}', f'--region={REGION}', '--quiet',
             '--no-traffic', '--tag=partner-auth-validation',
             '--no-allow-unauthenticated', '--env-vars-file=' + str(env_file),
             '--set-secrets=' + secret_refs, '--service-account=' + flags['service-account'],
             '--labels=partner-auth-source=' + digest.hexdigest()[:32]])
        candidate = json.loads(run(describe, capture=True))
        tagged = next(route for route in candidate['status']['traffic']
                      if route.get('tag') == 'partner-auth-validation')
        revision = tagged['revisionName']
        token = run([cloud, 'auth', 'print-identity-token'], capture=True).strip()
        request = Request(tagged['url'] + '/health', headers={'Authorization': 'Bearer ' + token})
        with urlopen(request, timeout=30) as response:
            record['healthStatus'] = response.status
        if record['healthStatus'] != 200:
            raise RuntimeError('Candidate health check failed; traffic unchanged.')
        run([cloud, 'run', 'services', 'update-traffic', TARGET,
             '--to-revisions=' + revision + '=100', f'--project={PROJECT}',
             f'--region={REGION}', '--quiet'])
        record['trafficPromoted'] = True
        run(['node', 'deploy/scripts/verify-partner-push-dev.cjs'])
        verification = REPO.parent / 'phool-gobhi-partner-app/.dart_tool/partner-push-dev-verification.json'
        record['tokenVerification'] = json.loads(verification.read_text(encoding='utf-8'))
        record['after'] = json.loads(run(describe, capture=True))
        record['deployed'] = True
        print(f"Deployed {revision}; health HTTP {record['healthStatus']}")
    except Exception as error:
        record['error'] = str(error)
        if record.get('trafficPromoted'):
            previous = ','.join(f"{route['revisionName']}={route['percent']}"
                                for route in record['before']['status']['traffic']
                                if route.get('percent', 0) > 0)
            if previous:
                run([cloud, 'run', 'services', 'update-traffic', TARGET,
                     '--to-revisions=' + previous, f'--project={PROJECT}',
                     f'--region={REGION}', '--quiet'])
                record['rolledBack'] = True
        raise
    finally:
        report.write_text(json.dumps(record, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
