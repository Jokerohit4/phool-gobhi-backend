"""Publish reviewed motion derivatives to the dedicated public exercise-dev bucket.

Default is validation only. --upload writes the three approved media files and
their public provenance. Never uses the medical bucket or a production target.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(tempfile.gettempdir()) / 'exercise-public-media/rendered'
BUCKET = 'phool-gobhi-exercise-media-dev'
CLOUD = shutil.which('gcloud.cmd') or shutil.which('gcloud')


def cloud(*args, allow_failure=False):
    result = subprocess.run([CLOUD, *args, '--project=phool-gobhi'], capture_output=True, text=True)
    if result.returncode and not allow_failure:
        raise RuntimeError('Exercise-dev storage operation failed: ' + result.stderr[-400:])
    return result


def main():
    manifest = json.loads((CACHE / 'manifest.json').read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    for name, row in manifest.items():
        if name not in catalogue or row['equipment'] != catalogue[name]['equipment'] or row['reviewStatus'] != 'approved_reference' or row['rights'] not in {'public_domain', 'cc_by_sa_4'} or row['codec'] != 'h264':
            raise RuntimeError('Incomplete movement/rights/codec review')
        for asset in row['files'].values():
            path = Path(asset['path']).resolve()
            if not path.is_relative_to(CACHE.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
                raise RuntimeError('Unreviewed or modified output asset')
    if '--upload' not in sys.argv:
        print(json.dumps({'target': BUCKET, 'exercises': len(manifest), 'bytes': sum(asset['bytes'] for row in manifest.values() for asset in row['files'].values()), 'uploaded': False}))
        return
    # gcloud's standardized output omits projectNumber; raw API metadata retains it.
    bucket = cloud('storage', 'buckets', 'describe', 'gs://' + BUCKET, '--raw', '--format=json', allow_failure=True)
    if bucket.returncode:
        if not any(term in bucket.stderr.lower() for term in ['404', 'does not exist', 'not found']):
            raise RuntimeError('Cannot verify dedicated dev bucket')
        cloud('storage', 'buckets', 'create', 'gs://' + BUCKET, '--location=asia-south1', '--uniform-bucket-level-access')
        # This new bucket contains only public exercise reference assets.
        cloud('storage', 'buckets', 'add-iam-policy-binding', 'gs://' + BUCKET, '--member=allUsers', '--role=roles/storage.objectViewer')
    else:
        config = json.loads(bucket.stdout)
        if str(config.get('projectNumber', config.get('project_number', ''))) != '1077801427223':
            raise RuntimeError('Unexpected bucket owner; refusing publication')
        policy = json.loads(cloud('storage', 'buckets', 'get-iam-policy', 'gs://' + BUCKET, '--format=json').stdout)
        if not any(binding['role'] == 'roles/storage.objectViewer' and 'allUsers' in binding.get('members', []) for binding in policy.get('bindings', [])):
            raise RuntimeError('Existing bucket is not already public; refusing to expose its contents')
    file = ROOT / 'prisma/derivedExerciseMedia.json'
    stored = json.loads(file.read_text(encoding='utf-8'))
    mime = {'gif': 'image/gif', 'video': 'video/mp4', 'image': 'image/jpeg'}
    fields = {'gif': 'gifUrl', 'video': 'videoUrl', 'image': 'imageUrl'}
    published = []
    for name, row in manifest.items():
        result = {key: row[key] for key in ['equipment', 'provider', 'sourceUrl', 'sourceTitle', 'author', 'rights', 'licenseUrl', 'sourceId', 'sourceVideoSha256', 'attribution', 'durationSeconds', 'codec', 'kind', 'reviewStatus', 'reviewReason']}
        result['assetSha256'] = {}
        for key, asset in row['files'].items():
            path = Path(asset['path'])
            object_name = 'references/' + row['sourceId'] + '/' + asset['sha256'] + path.suffix
            target = 'gs://' + BUCKET + '/' + object_name
            cloud('storage', 'cp', str(path), target, '--content-type=' + mime[key], '--cache-control=public,max-age=31536000,immutable')
            url = 'https://storage.googleapis.com/' + BUCKET + '/' + object_name
            with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=20) as response:
                if response.status != 200 or response.headers.get_content_type() != mime[key] or int(response.headers.get('content-length', '0')) != asset['bytes']:
                    raise RuntimeError('Published media verification failed')
            result[fields[key]] = url
            result['assetSha256'][key] = asset['sha256']
        stored[name] = result
        published.append(name)
    temporary = file.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(stored, indent=2) + '\n', encoding='utf-8')
    temporary.replace(file)
    print(json.dumps({'target': BUCKET, 'published': published, 'allAssetsVerified': True, 'databaseWrites': 0}))


if __name__ == '__main__':
    main()
