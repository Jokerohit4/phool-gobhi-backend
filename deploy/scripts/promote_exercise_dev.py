"""Promote an already verified exercise revision on DEV and smoke-test it."""
import datetime
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / 'docs' / 'exercise-dev'
CLOUD = shutil.which('gcloud.cmd') or shutil.which('gcloud')


def cloud(*args):
    result = subprocess.run([CLOUD, *args, '--project=phool-gobhi'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Dev cloud operation failed; credential output suppressed')
    return result.stdout


def main():
    deployment = json.loads((REPORTS / 'deployment.json').read_text())
    verified = json.loads((REPORTS / 'verify.json').read_text())
    assert deployment['target'] == 'health-service-dev'
    assert deployment['taggedRevision'].startswith('health-service-dev-')
    assert verified['target'] == 'dev' and verified['gifComplete']
    assert verified['http']['url'] == deployment['taggedUrl']
    assert verified['http']['detailsChecked'] == 1103 and not verified['http']['failures']
    checked = datetime.datetime.fromisoformat(verified['checkedAt'].replace('Z', '+00:00'))
    assert (datetime.datetime.now(datetime.timezone.utc) - checked).total_seconds() < 3600
    service = json.loads(cloud('run', 'services', 'describe', 'health-service-dev', '--region=asia-south1', '--format=json'))
    traffic = [row for row in service['status']['traffic'] if row.get('percent', 0)]
    assert len(traffic) == 1 and traffic[0]['percent'] == 100
    assert traffic[0]['revisionName'] in (deployment['previousRevision'], deployment['taggedRevision']), 'Dev traffic changed since staging; refusing to overwrite'
    assert any(row.get('revisionName') == deployment['taggedRevision'] and row.get('url') == deployment['taggedUrl'] for row in service['status']['traffic'])
    cloud('run', 'services', 'update-traffic', 'health-service-dev', '--region=asia-south1', '--to-revisions=' + deployment['taggedRevision'] + '=100', '--quiet')
    token = cloud('auth', 'print-identity-token').strip()
    url = service['status']['url']

    def get(path):
        request = urllib.request.Request(url + path, headers={'Authorization': 'Bearer ' + token, 'x-user-id': '0', 'x-user-role': 'customer', 'x-user-type': 'gym_seeker'})
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)

    health = get('/health')
    library = get('/exercises')['data']
    assert len(library) == 1103 and all(row.get('demoGifUrl') for row in library)
    probes = {}
    for name in ['Cat-Cow', 'March in Place', 'High Plank', 'Kettlebell Halo']:
        row = next(row for row in library if row['name'] == name)
        detail = get('/exercises/' + str(row['id']) + '?lang=en')['data']
        assert detail.get('demoGifUrl') and detail.get('demoImageUrl')
        probes[name] = {'id': row['id'], 'demoGifUrl': detail['demoGifUrl'], 'kind': detail.get('demoGifKind', 'motion')}
    after = json.loads(cloud('run', 'services', 'describe', 'health-service-dev', '--region=asia-south1', '--format=json'))
    assert any(row.get('revisionName') == deployment['taggedRevision'] and row.get('percent') == 100 for row in after['status']['traffic'])
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    deployment.update(promotedToDev=True, verifiedAt=now)
    (REPORTS / 'deployment.json').write_text(json.dumps(deployment, indent=2) + '\n')
    smoke = {'checkedAt': now, 'url': url, 'revision': deployment['taggedRevision'], 'health': health, 'libraryRows': len(library), 'missingGif': 0, 'probes': probes, 'productionChanged': False}
    (REPORTS / 'live-smoke.json').write_text(json.dumps(smoke, indent=2) + '\n')
    print(json.dumps(smoke, indent=2))


if __name__ == '__main__':
    main()
