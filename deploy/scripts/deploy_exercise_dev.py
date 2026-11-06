"""Stage the reviewed health-service source and deploy a dev-only tagged revision.

Preserves the current dev environment, secret bindings and runtime configuration.
Does not promote traffic, alter a database, or support a production target.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path('services/health-service')
CLOUD = shutil.which('gcloud.cmd') or shutil.which('gcloud')
TARGET = 'health-service-dev'


def run(args, capture=False):
    result = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        if capture:
            print(result.stderr[-2000:])
        raise RuntimeError('Dev deployment operation failed')
    return result.stdout if capture else ''


def main():
    git = ['git', '-c', 'safe.directory=' + ROOT.as_posix()]
    if run(git + ['branch', '--show-current'], True).strip() != 'dev':
        raise RuntimeError('Dev checkout required')
    run(['node', 'scripts/check-analytics-events.cjs'])
    run(['node', 'deploy/scripts/check-undeclared-imports.cjs', 'health-service'])
    config = json.loads(run([CLOUD, 'run', 'services', 'describe', TARGET, '--project=phool-gobhi', '--region=asia-south1', '--format=json'], True))
    live = next(t['revisionName'] for t in config['status']['traffic'] if t.get('percent') == 100)
    spec = config['spec']['template']['spec']
    environment_hash = hashlib.sha256(json.dumps(spec['containers'][0].get('env', []), sort_keys=True).encode()).hexdigest()
    stage = Path(tempfile.mkdtemp(prefix='exercise-dev-'))
    files = {Path(p) for p in run(git + ['ls-files', '-z', '--', SOURCE.as_posix()], True).split('\0') if p}
    # Include reviewed exercise additions, including required runtime JSON/source credits.
    for folder in ['prisma/sources']:
        files.update(p.relative_to(ROOT) for p in (ROOT / SOURCE / folder).rglob('*') if p.is_file())
    for name in ['prisma/exerciseReferenceData.json', 'prisma/exerciseSources.json', 'prisma/exerciseSupplements.json',
                 'prisma/exerciseVideos.json', 'prisma/exerciseTutorialReplacements.json', 'prisma/ownedExerciseContent.json', 'prisma/derivedExerciseMedia.json', 'services/exerciseSourceService.js',
                 'services/exerciseReferenceService.js', 'services/exerciseDerivedMediaService.js', 'services/exercisePoseGifService.js', 'prisma/exercisePoseGifs.json', 'utils/exerciseContentBundle.js', 'utils/exerciseMedia.js',
                 'utils/hasanExerciseDataset.js', 'services/exerciseInstructionService.js', 'prisma/exerciseInstructionFallbacks.json']:
        files.add(SOURCE / name)
    digest = hashlib.sha256()
    for relative in sorted(files):
        origin = ROOT / relative
        name = relative.relative_to(SOURCE)
        if not origin.is_file() or origin.name.startswith('.env') or any(p in {'node_modules', '.git'} for p in name.parts):
            continue
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin, destination)
        digest.update(name.as_posix().encode())
        digest.update(origin.read_bytes())
    report = {'target': TARGET, 'previousRevision': live, 'stage': str(stage), 'sourceSha256': digest.hexdigest(),
              'environmentSha256': environment_hash, 'serviceAccount': spec['serviceAccountName']}
    output = ROOT / 'docs/exercise-dev/deployment.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)
    run([CLOUD, 'run', 'deploy', TARGET, '--source=' + str(stage), '--project=phool-gobhi', '--region=asia-south1',
         '--no-traffic', '--tag=exercises-check', '--no-allow-unauthenticated', '--quiet',
         '--service-account=' + spec['serviceAccountName']])
    updated = json.loads(run([CLOUD, 'run', 'services', 'describe', TARGET, '--project=phool-gobhi', '--region=asia-south1', '--format=json'], True))
    current_spec = updated['spec']['template']['spec']
    actual_hash = hashlib.sha256(json.dumps(current_spec['containers'][0].get('env', []), sort_keys=True).encode()).hexdigest()
    if actual_hash != environment_hash or current_spec['serviceAccountName'] != spec['serviceAccountName']:
        raise RuntimeError('Dev runtime bindings changed; tagged revision was not promoted')
    tag = next(t for t in updated['status']['traffic'] if t.get('tag') == 'exercises-check')
    report.update({'taggedRevision': tag['revisionName'], 'taggedUrl': tag['url'], 'bindingsPreserved': True})
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
