"""Convert reviewed CC BY-SA artwork into labelled reference-pose GIFs."""
import hashlib
import json
from pathlib import Path
import tempfile
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'prisma/sources'
CACHE = Path(tempfile.gettempdir()) / 'exercise-pose-references'
OUTPUT = CACHE / 'pose-references'
LICENSE = 'https://creativecommons.org/licenses/by-sa/4.0/'


def main():
    decisions = json.loads((SOURCES / 'workout-guide-mappings.json').read_text(encoding='utf-8'))
    reviewed = json.loads((ROOT.parents[1] / 'docs/exercise-dev/reference-review/workout-guide-review.json').read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    revision = json.loads((SOURCES / 'workout-guide-provenance.json').read_text(encoding='utf-8'))['revision']
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
                raise RuntimeError('Reviewed artwork hash changed')
            original = Image.open(path).convert('RGBA')
            background = Image.new('RGBA', original.size, '#17232a')
            background.alpha_composite(original)
            photo = ImageOps.contain(background.convert('RGB'), (360, 340), Image.Resampling.LANCZOS)
            frame = Image.new('RGB', (360, 400), '#17232a')
            frame.paste(photo, ((360-photo.width)//2, 36+(340-photo.height)//2))
            draw = ImageDraw.Draw(frame)
            draw.rectangle((0, 0, 360, 35), fill='#135943')
            draw.text((12, 8), f'REFERENCE POSE {index+1} OF {len(record["images"])}', fill='white', font=font)
            draw.text((12, 381), 'Bryl Lim / CC BY-SA 4.0 / Pose sequence', fill='white', font=small)
            frames.append(frame)
            hashes.append(source['sha256'])
            urls.append(source['url'])
        if len(set(hashes)) < 2:
            raise RuntimeError('No distinct pose artwork')
        temp = CACHE / 'workout-guide-current.gif'
        frames[0].save(temp, save_all=True, append_images=frames[1:], duration=1500, loop=0, optimize=False)
        digest = hashlib.sha256(temp.read_bytes()).hexdigest()
        target = OUTPUT / (digest + '.gif')
        temp.replace(target)
        thumbnail = CACHE / 'workout-guide-preview.jpg'
        frames[0].save(thumbnail, quality=90)
        preview_hash = hashlib.sha256(thumbnail.read_bytes()).hexdigest()
        thumbnail.replace(OUTPUT / (preview_hash + '.jpg'))
        source_url = f'https://github.com/bryllim/workout-guide/tree/{revision}/packages/workout-guide/assets/{decision["slug"]}'
        manifest[name] = {'equipment': catalogue[name]['equipment'], 'kind': 'pose_sequence',
            'gifUrl': 'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/' + target.name,
            'previewImageUrl': 'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/' + preview_hash + '.jpg',
            'previewImageSha256': preview_hash,
            'attribution': f'Illustrations by Bryl Lim; includes Everkinetic-derived artwork. CC BY-SA 4.0. {LICENSE} Source: {source_url}. Resized, composited and labelled pose GIF by Phool Gobhi; derivatives licensed CC BY-SA 4.0.',
            'sourceUrl': source_url, 'sourceImageUrls': urls, 'sourceImageSha256': hashes,
            'licenseUrl': LICENSE, 'rights': 'cc_by_sa_4', 'assetSha256': digest,
            'frameCount': len(frames), 'frameDurationMs': 1500,
            'labels': 'Reference pose 1, 2, 3; pose sequence', 'userApprovedPoseSequences': True,
            'reviewReason': decision['reviewReason']}
    (CACHE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'rendered': len(manifest), 'rights': 'cc_by_sa_4'}))


if __name__ == '__main__':
    main()
