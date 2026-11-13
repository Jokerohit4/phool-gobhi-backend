"""Fetch pinned CC BY-SA pose artwork and create contact sheets for variant review."""
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
CACHE = Path(tempfile.gettempdir()) / 'exercise-workout-guide'


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    mappings = json.loads((SOURCES / 'workout-guide-mappings.json').read_text(encoding='utf-8'))
    catalog = {row['slug']: row for row in json.loads((SOURCES / 'workout-guide.json').read_text(encoding='utf-8'))}
    revision = json.loads((SOURCES / 'workout-guide-provenance.json').read_text(encoding='utf-8'))['revision']
    tree = json.loads((SOURCES / 'bryllim-research-tree.json').read_text(encoding='utf-8'))
    known = {row['path']: row['sha'] for row in tree['tree'] if row['type'] == 'blob'}

    def fetch(item):
        name, decision = item
        source = catalog[decision['slug']]
        images = []
        for frame in source['frames']:
            path = 'packages/workout-guide/' + frame['path'].replace('.svg', '.png')
            if path not in known or frame['attribution']['license'] != 'CC BY-SA 4.0':
                raise RuntimeError('Missing pinned image or per-frame license')
            file = CACHE / (source['slug'] + '-' + str(frame['index']) + '.png')
            url = f'https://raw.githubusercontent.com/bryllim/workout-guide/{revision}/{path}'
            if not file.exists():
                with urllib.request.urlopen(url, timeout=30) as response:
                    file.write_bytes(response.read())
            data = file.read_bytes()
            if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != known[path]:
                raise RuntimeError('Pinned artwork blob differs')
            images.append({'path': str(file), 'url': url, 'sha256': hashlib.sha256(data).hexdigest()})
        return name, {'slug': source['slug'], 'source': source, 'images': images}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        records = dict(pool.map(fetch, mappings.items()))
    for batch, start in enumerate(range(0, len(records), 12), 1):
        rows = list(records.items())[start:start + 12]
        sheet = Image.new('RGB', (1080, len(rows) * 190), 'white')
        draw = ImageDraw.Draw(sheet)
        for index, (name, row) in enumerate(rows):
            draw.text((5, index * 190 + 2), name + ' / ' + row['slug'], fill='black')
            for number, image in enumerate(row['images']):
                original = Image.open(image['path']).convert('RGBA')
                background = Image.new('RGBA', original.size, '#17232a')
                background.alpha_composite(original)
                photo = ImageOps.contain(background.convert('RGB'), (340, 165))
                sheet.paste(photo, (number * 360, index * 190 + 23))
        sheet.save(OUTPUT / f'workout-guide-{batch}.jpg')
    (OUTPUT / 'workout-guide-review.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'exercises': len(records), 'sheets': batch, 'verifiedPinnedArtwork': True}))


if __name__ == '__main__':
    main()
