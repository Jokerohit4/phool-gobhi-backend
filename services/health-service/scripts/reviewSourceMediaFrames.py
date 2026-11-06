"""Download selected licensed source GIFs and make labelled review contact sheets.

Usage: python scripts/reviewSourceMediaFrames.py <batch-name> <id> <id> ...
Only original source paths from the pinned retained dataset are requested.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import urllib.request
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
SOURCE = {row['id']: row for row in json.loads((PRISMA / 'sources/hasaneyldrm-exercises-dataset.json').read_text(encoding='utf-8'))}
PROVENANCE = json.loads((PRISMA / 'sources/hasaneyldrm-provenance.json').read_text(encoding='utf-8'))
CACHE = Path(tempfile.gettempdir()) / 'exercise-source-review'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev/reference-review'


def download(source_id):
    row = SOURCE[source_id]
    path = CACHE / (source_id + '.gif')
    url = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/' + PROVENANCE['revision'] + '/' + row['gif_url']
    if not path.exists():
        with urllib.request.urlopen(url, timeout=30) as response:
            if response.headers.get_content_type() != 'image/gif':
                raise RuntimeError('Unexpected source MIME type')
            path.write_bytes(response.read())
    return row, path, url


def main():
    batch, *ids = sys.argv[1:]
    if not batch.replace('-', '').isalnum() or not ids:
        raise RuntimeError('Supply a batch label and source IDs')
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        assets = list(pool.map(download, ids))
    manifest = []
    for group in range(0, len(assets), 14):
        selected = assets[group:group + 14]
        sheet = Image.new('RGB', (1000, 220 * ((len(selected) + 1) // 2)), 'white')
        draw = ImageDraw.Draw(sheet)
        for index, (row, path, url) in enumerate(selected):
            left, top = index % 2 * 500, index // 2 * 220
            draw.text((left + 3, top + 3), (row['id'] + ' ' + row['name'])[:66], fill='black')
            image = Image.open(path)
            frames = [0, image.n_frames // 3, image.n_frames * 2 // 3]
            for column, frame in enumerate(frames):
                image.seek(frame)
                thumbnail = image.convert('RGB')
                thumbnail.thumbnail((160, 180))
                sheet.paste(thumbnail, (left + column * 164, top + 28))
            manifest.append({'sourceId': row['id'], 'name': row['name'], 'sourceUrl': url,
                             'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'framesSampled': frames,
                             'attribution': row['attribution']})
        sheet.save(OUTPUT / f'{batch}-{group // 14 + 1}.jpg')
    (OUTPUT / f'{batch}.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'reviewedAssets': len(assets), 'sheets': (len(assets) + 13) // 14}))


if __name__ == '__main__':
    main()
