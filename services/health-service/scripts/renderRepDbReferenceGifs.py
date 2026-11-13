"""App-only, deterministic conversion of reviewed RepDB free-tier reference poses.

No premium files, generative transformations, or standalone dataset publication.
"""
import hashlib
import json
from pathlib import Path
import tempfile
from PIL import Image, ImageDraw, ImageFont, ImageOps
ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'prisma/sources'
CACHE = Path(tempfile.gettempdir()) / 'exercise-pose-references'
OUTPUT = CACHE / 'pose-references'


def main():
    decisions = json.loads((SOURCES / 'repdb-reviewed-mappings.json').read_text(encoding='utf-8'))
    reviewed = json.loads((ROOT.parents[1] / 'docs/exercise-dev/reference-review/repdb-pose-review.json').read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    revision = json.loads((SOURCES / 'repdb-provenance.json').read_text(encoding='utf-8'))['revision']
    license_url = f'https://github.com/RepDB/exercise-dataset/blob/{revision}/LICENSE-DATA.md'
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
    small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 13)
    for name, decision in decisions.items():
        if decision['reviewStatus'] != 'approved_reference':
            continue
        record = reviewed[name]
        frames, hashes, urls = [], [], []
        for index, source in enumerate(record['images']):
            path = Path(source['path'])
            if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
                raise RuntimeError('Reviewed free-tier artwork changed')
            photo = ImageOps.contain(Image.open(path).convert('RGB'), (360, 340), Image.Resampling.LANCZOS)
            frame = Image.new('RGB', (360, 400), '#d9f1fa')
            frame.paste(photo, ((360-photo.width)//2, 36+(340-photo.height)//2))
            draw = ImageDraw.Draw(frame)
            draw.rectangle((0, 0, 360, 35), fill='#135943')
            label = 'HOLD POSITION REFERENCE' if decision['kind'] == 'hold_reference' else f'REFERENCE POSE {index+1} OF {len(record["images"])}'
            draw.text((12, 8), label, fill='white', font=font)
            draw.text((12, 381), 'Exercise data by RepDB (repdb.co)', fill='#333333', font=small)
            frames.append(frame); hashes.append(source['sha256']); urls.append(source['url'])
        if len(frames) < 2 and decision['kind'] != 'hold_reference':
            raise RuntimeError('Dynamic exercise requires distinct reference poses')
        temp = CACHE / 'repdb-current.gif'
        frames[0].save(temp, save_all=True, append_images=frames[1:], duration=1500, loop=0, optimize=False)
        digest = hashlib.sha256(temp.read_bytes()).hexdigest()
        target = OUTPUT / (digest + '.gif'); temp.replace(target)
        preview = CACHE / 'repdb-preview.jpg'; frames[0].save(preview, quality=90)
        preview_hash = hashlib.sha256(preview.read_bytes()).hexdigest(); preview.replace(OUTPUT / (preview_hash + '.jpg'))
        source_url = f'https://github.com/RepDB/exercise-dataset/blob/{revision}/exercises.json'
        manifest[name] = {'equipment': catalogue[name]['equipment'], 'kind': decision['kind'],
            'gifUrl': 'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/' + target.name,
            'previewImageUrl': 'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/' + preview_hash + '.jpg',
            'previewImageSha256': preview_hash,
            'attribution': f'Exercise data by RepDB (https://repdb.co). Free-tier artwork resized and labelled for in-app reference. {license_url}',
            'sourceUrl': source_url, 'sourceImageUrls': urls, 'sourceImageSha256': hashes,
            'licenseUrl': license_url, 'rights': 'repdb_free_in_app', 'assetSha256': digest,
            'frameCount': len(frames), 'frameDurationMs': 1500,
            'labels': label, 'userApprovedPoseSequences': True, 'reviewReason': decision['reviewReason']}
    (CACHE / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'rendered':len(manifest),'appOnly':True,'premiumAssets':0,'generativeTransformations':0}))


if __name__ == '__main__':
    main()
