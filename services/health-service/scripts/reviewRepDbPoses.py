"""Inspect pinned free-tier source poses. No premium or generative transformations."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request
from PIL import Image, ImageDraw, ImageOps
ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'prisma/sources'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev/reference-review'
CACHE = Path(tempfile.gettempdir()) / 'exercise-repdb-review'


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    mappings = json.loads((SOURCES / 'repdb-reviewed-mappings.json').read_text(encoding='utf-8'))
    catalogue = {row['id']: row for row in json.loads((SOURCES / 'repdb.json').read_text(encoding='utf-8'))['exercises']}
    tree = json.loads((SOURCES / 'RepDB-research-tree.json').read_text(encoding='utf-8'))
    files = {row['path']: row['sha'] for row in tree['tree'] if row['type'] == 'blob'}
    revision = tree['sha']

    def fetch(item):
        name, decision = item
        source = catalogue[decision['sourceId']]
        images = []
        for phase, path in source['images']['flat'].items():
            if not path.startswith('images/flat/') or path not in files:
                raise RuntimeError('Only pinned free-tier images are eligible')
            target = CACHE / Path(path).name
            url = f'https://raw.githubusercontent.com/RepDB/exercise-dataset/{revision}/{path}'
            if not target.exists():
                with urllib.request.urlopen(url, timeout=25) as response:
                    target.write_bytes(response.read())
            data = target.read_bytes()
            if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != files[path]:
                raise RuntimeError('Pinned source image changed')
            images.append({'phase': phase, 'url': url, 'path': str(target), 'sha256': hashlib.sha256(data).hexdigest()})
        return name, {'sourceId': source['id'], 'images': images}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        records = dict(pool.map(fetch, mappings.items()))
    for batch, start in enumerate(range(0, len(records), 10), 1):
        rows = list(records.items())[start:start+10]
        sheet = Image.new('RGB', (800, len(rows)*220), 'white')
        draw = ImageDraw.Draw(sheet)
        for number, (name, row) in enumerate(rows):
            draw.text((5, number*220+3), name + ' / ' + row['sourceId'], fill='black')
            for index, source in enumerate(row['images']):
                image = ImageOps.contain(Image.open(source['path']).convert('RGB'), (380, 190))
                sheet.paste(image, (index*400, number*220+25))
        sheet.save(OUTPUT / f'repdb-poses-{batch}.jpg')
    (OUTPUT / 'repdb-pose-review.json').write_text(json.dumps(records, indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'reviewed':len(records),'sheets':batch,'freeTierOnly':True}))


if __name__ == '__main__':
    main()
