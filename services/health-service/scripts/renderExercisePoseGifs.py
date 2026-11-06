"""Render user-approved, explicitly labelled photo-sequence GIF references.

No inferred in-between motion, guessed source paths, uploads or database writes.
Only pinned public-domain free-exercise-db photo sequences are eligible here.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT.parents[1] / 'docs/exercise-dev'
CACHE = Path(tempfile.gettempdir()) / 'exercise-pose-references'
OUTPUT = CACHE / 'pose-references'
PREFIX = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/a859101d633a01c4a1a920d6a8ce41dabba0705f/exercises/'
FONT = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
SMALL = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 13)
STATIC_HOLDS = {'Seated Hamstring Stretch', 'Seated Floor Hamstring Stretch', 'Standing Hamstring and Calf Stretch', 'The Straddle', 'Brachialis-SMR'}


def render(row):
    urls = list(dict.fromkeys(row['urls']))
    if len(urls) < 2 or not all(url.startswith(PREFIX) for url in urls):
        return None
    frames, hashes = [], []
    for index, url in enumerate(urls):
        source = CACHE / (hashlib.sha256(url.encode()).hexdigest() + '.jpg')
        if not source.exists():
            with urllib.request.urlopen(url, timeout=25) as response:
                if response.headers.get_content_type() not in {'image/jpeg', 'image/png'}:
                    raise RuntimeError('Unexpected source MIME')
                data = response.read()
            source.write_bytes(data)
        hashes.append(hashlib.sha256(source.read_bytes()).hexdigest())
        with Image.open(source) as original:
            photo = ImageOps.contain(original.convert('RGB'), (360, 340), Image.Resampling.LANCZOS)
        frame = Image.new('RGB', (360, 400), 'white')
        frame.paste(photo, ((360 - photo.width) // 2, 36 + (340 - photo.height) // 2))
        draw = ImageDraw.Draw(frame)
        draw.rectangle((0, 0, 360, 35), fill='#135943')
        # Neutral numbering avoids claiming that every source's index 0 is the start.
        draw.text((12, 8), f'REFERENCE POSE {index + 1} OF {len(urls)}', fill='white', font=FONT)
        draw.text((12, 381), 'Exercise photo sequence', fill='#444444', font=SMALL)
        frames.append(frame)
    kind = 'pose_sequence'
    if len(set(hashes)) < 2:
        if row['name'] not in STATIC_HOLDS:
            raise RuntimeError('Duplicate source images cannot establish a pose sequence')
        # These definitions specify a static hold, not movement between two poses.
        kind = 'hold_reference'
        frames, urls, hashes = frames[:1], urls[:1], hashes[:1]
        draw = ImageDraw.Draw(frames[0])
        draw.rectangle((0, 0, 360, 35), fill='#135943')
        draw.text((12, 8), 'HOLD POSITION REFERENCE', fill='white', font=FONT)
    temp = CACHE / (hashlib.sha256(row['name'].encode()).hexdigest() + '.gif')
    frames[0].save(temp, format='GIF', save_all=True, append_images=frames[1:], duration=1500, loop=0, optimize=False)
    digest = hashlib.sha256(temp.read_bytes()).hexdigest()
    target = OUTPUT / (digest + '.gif')
    temp.replace(target)
    with Image.open(target) as gif:
        if gif.n_frames != len(urls):
            raise RuntimeError('Pose frame encoding mismatch')
    return row['name'], {'equipment': row['equipment'], 'kind': kind,
        'gifUrl': 'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/' + target.name,
        'attribution': row['attribution'] + ('. Labelled hold-position GIF reference.' if kind == 'hold_reference' else '. Labelled photo-sequence GIF; source poses retained.'),
        'sourceUrl': row.get('sourceUrl') or urls[0], 'sourceImageUrls': urls, 'sourceImageSha256': hashes,
        'licenseUrl': 'https://unlicense.org/', 'rights': 'public_domain',
        'assetSha256': digest, 'frameCount': len(urls), 'frameDurationMs': 1500,
        'labels': 'Reference pose 1, 2, ...; exercise photo sequence',
        'userApprovedPoseSequences': True}


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rows = json.loads((REPORTS / 'pose-gif-candidates.json').read_text(encoding='utf-8'))
    result, failures = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(render, row): row['name'] for row in rows}
        for future in concurrent.futures.as_completed(futures):
            try:
                item = future.result()
                if item:
                    result[item[0]] = item[1]
            except Exception as error:
                failures.append({'name': futures[future], 'reason': str(error)})
    result = dict(sorted(result.items()))
    (REPORTS / 'pose-gif-render-failures.json').write_text(json.dumps(failures, indent=2) + '\n', encoding='utf-8')
    (CACHE / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'rendered': len(result), 'uniqueAssets': len({row['gifUrl'] for row in result.values()}), 'failures': failures, 'directory': str(OUTPUT)}))


if __name__ == '__main__':
    main()
