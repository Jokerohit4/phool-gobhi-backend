"""Upload only validated, user-approved pose GIFs to the public exercise-dev bucket."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(tempfile.gettempdir()) / 'exercise-pose-references'
BUCKET = 'phool-gobhi-exercise-media-dev'
CLOUD = shutil.which('gcloud.cmd') or shutil.which('gcloud')


def cloud(*args):
    result = subprocess.run([CLOUD, *args, '--project=phool-gobhi'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Dev exercise storage operation failed: ' + result.stderr[-300:])
    return result.stdout


def main():
    data = json.loads((CACHE / 'manifest.json').read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    stage = Path(tempfile.mkdtemp(prefix='exercise-pose-upload-')) / 'pose-references'
    stage.mkdir()
    for name, row in data.items():
        if name not in catalogue or row['equipment'] != catalogue[name]['equipment'] or row['rights'] not in {'public_domain', 'cc_by_sa_4', 'repdb_free_in_app', 'phool_gobhi_original'} or row['kind'] not in {'pose_sequence', 'hold_reference', 'schematic_pose_sequence'} or not row['userApprovedPoseSequences'] or row['frameCount'] < (1 if row['kind'] == 'hold_reference' else 2):
            raise RuntimeError('Unapproved or incompatible pose reference')
        if row['rights'] == 'cc_by_sa_4' and (row['licenseUrl'] != 'https://creativecommons.org/licenses/by-sa/4.0/' or 'derivatives licensed CC BY-SA 4.0' not in row['attribution']):
            raise RuntimeError('Missing derivative license or credit')
        if row['rights'] == 'repdb_free_in_app' and ('Exercise data by RepDB' not in row['attribution'] or not row['licenseUrl'].startswith('https://github.com/RepDB/exercise-dataset/blob/')):
            raise RuntimeError('Missing free-tier license or attribution')
        if row['rights'] == 'phool_gobhi_original':
            if row.get('reviewStatus') != 'approved_reference' or row['kind'] != 'schematic_pose_sequence':
                raise RuntimeError('Original schematic is not visually reviewed')
            for file, digest in zip(row['sourceVectorFiles'], row['sourceImageSha256']):
                path = Path(file).resolve()
                if not path.is_relative_to((ROOT / 'prisma/sources/phool-gobhi-pose-art').resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise RuntimeError('Original SVG source differs from review')
                shutil.copy2(path, stage / (digest + '.svg'))
        digest = row['assetSha256']
        source = CACHE / 'pose-references' / (digest + '.gif')
        if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Pose asset hash mismatch')
        with Image.open(source) as gif:
            if gif.n_frames != row['frameCount'] or gif.size != (360, 400):
                raise RuntimeError('Unexpected pose asset frames or dimensions')
        shutil.copy2(source, stage / source.name)
        if row.get('previewImageSha256'):
            preview = CACHE / 'pose-references' / (row['previewImageSha256'] + '.jpg')
            if hashlib.sha256(preview.read_bytes()).hexdigest() != row['previewImageSha256']:
                raise RuntimeError('Preview hash mismatch')
            shutil.copy2(preview, stage / preview.name)
    if '--upload' not in sys.argv:
        print(json.dumps({'target': BUCKET, 'exercises': len(data), 'uploaded': False}))
        return
    config = json.loads(cloud('storage', 'buckets', 'describe', 'gs://' + BUCKET, '--raw', '--format=json'))
    if str(config.get('projectNumber')) != '1077801427223':
        raise RuntimeError('Unexpected dev bucket owner')
    policy = json.loads(cloud('storage', 'buckets', 'get-iam-policy', 'gs://' + BUCKET, '--format=json'))
    if not any(row['role'] == 'roles/storage.objectViewer' and 'allUsers' in row.get('members', []) for row in policy.get('bindings', [])):
        raise RuntimeError('Refusing to expose a private bucket')
    cloud('storage', 'cp', '--recursive', str(stage), 'gs://' + BUCKET + '/', '--cache-control=public,max-age=31536000,immutable', '--quiet')

    def verify(row):
        size = (stage / (row['assetSha256'] + '.gif')).stat().st_size
        with urllib.request.urlopen(urllib.request.Request(row['gifUrl'], method='HEAD'), timeout=25) as response:
            if response.status != 200 or response.headers.get_content_type() != 'image/gif' or int(response.headers.get('content-length', '0')) != size:
                raise RuntimeError('Published GIF verification failed')
        if row.get('previewImageUrl'):
            with urllib.request.urlopen(urllib.request.Request(row['previewImageUrl'], method='HEAD'), timeout=25) as response:
                if response.status != 200 or response.headers.get_content_type() != 'image/jpeg':
                    raise RuntimeError('Published preview verification failed')
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(verify, data.values()))
    file = ROOT / 'prisma/exercisePoseGifs.json'
    stored = json.loads(file.read_text(encoding='utf-8')) if file.exists() else {}
    stored.update({name: {key: value for key, value in row.items() if key != 'sourceVectorFiles'} for name, row in data.items()})
    temporary = file.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(stored, indent=2) + '\n', encoding='utf-8')
    temporary.replace(file)
    print(json.dumps({'target': BUCKET, 'exercises': len(data), 'assetsVerified': True, 'databaseWrites': 0}))


if __name__ == '__main__':
    main()
