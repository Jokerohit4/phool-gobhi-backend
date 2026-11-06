"""Render reviewed public-domain motion into GIF, H.264 MP4 and thumbnail assets.

No uploads or database writes. Uses original source SHA-256, validated clip bounds
and an explicit variant review. Never converts still pictures into motion demos.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(tempfile.gettempdir()) / 'exercise-public-media'
OUTPUT = CACHE / 'rendered'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
DISCLAIMER = 'The appearance of U.S. Department of War (DoW) visual information does not imply or constitute DoW endorsement.'


def render():
    decisions = json.loads((ROOT / 'prisma/sources/public-exercise-media-mappings.json').read_text(encoding='utf-8'))
    provenance = json.loads((ROOT / 'prisma/sources/public-exercise-media-provenance.json').read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, decision in decisions.items():
        if decision['reviewStatus'] != 'approved_reference':
            continue
        if decision['rights'] not in {'public_domain', 'cc_by_sa_4'} or name not in catalogue or not decision.get('reviewReason'):
            raise RuntimeError('Unreviewed rights or catalogue mapping')
        source = provenance[name]
        path = CACHE / (source['sourceId'] + '.mp4')
        if hashlib.sha256(path.read_bytes()).hexdigest() != source['sourceVideoSha256']:
            raise RuntimeError('Source footage hash mismatch')
        start, duration = decision['clipStartSeconds'], decision['clipDurationSeconds']
        if start < 0 or duration <= 0 or start + duration > source['sourceDurationSeconds']:
            raise RuntimeError('Clip exceeds original footage')
        x, y, width, height = decision['crop']
        if min(x, y) < 0 or min(width, height) <= 0 or x + width > source['sourceDimensions'][0] or y + height > source['sourceDimensions'][1]:
            raise RuntimeError('Invalid full-body crop')
        prefix = OUTPUT / source['sourceId']
        gif, video, image = [prefix.with_suffix(extension) for extension in ['.gif', '.mp4', '.jpg']]
        crop = f'crop={width}:{height}:{x}:{y}'
        base = [FFMPEG, '-v', 'error', '-y', '-ss', str(start), '-t', str(duration), '-i', str(path)]
        commands = [
            base + ['-vf', crop + ',scale=640:-2:flags=lanczos', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '25', '-movflags', '+faststart', str(video)],
            base + ['-filter_complex', crop + ',fps=8,scale=180:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-an', '-loop', '0', str(gif)],
            [FFMPEG, '-v', 'error', '-y', '-ss', str(start + min(3.5, duration / 2)), '-i', str(path), '-frames:v', '1', '-vf', crop + ',scale=640:-2:flags=lanczos', str(image)],
        ]
        for command in commands:
            result = subprocess.run(command, capture_output=True)
            if result.returncode:
                raise RuntimeError('Reviewed media conversion failed: ' + result.stderr.decode('utf-8', errors='replace')[-300:])
        attribution = f"{decision['author']} / U.S. Marine Corps, via DVIDS. Public domain. " + DISCLAIMER
        if decision['provider'] == 'wger':
            attribution = f"{decision['author']}, via wger. CC BY-SA 4.0. {decision['licenseUrl']} Source: {decision['sourceUrl']}. Cropped, clipped, resized and converted to GIF/JPG/H.264 by Phool Gobhi; derivatives licensed CC BY-SA 4.0."
        manifest[name] = {**decision, 'equipment': catalogue[name]['equipment'],
                          'sourceId': source['sourceId'], 'sourceVideoSha256': source['sourceVideoSha256'],
                          'attribution': attribution,
                          'durationSeconds': duration, 'codec': 'h264', 'kind': 'demo',
                          'files': {key: {'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes': file.stat().st_size}
                                    for key, file in [('gif', gif), ('video', video), ('image', image)]}}
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'renderedExercises': len(manifest), 'assets': sum(len(row['files']) for row in manifest.values()), 'manifest': str(OUTPUT / 'manifest.json')}))


if __name__ == '__main__':
    render()
