"""Inspect explicitly selected public-domain exercise footage before conversion.

Downloads the public playback asset referenced by the publisher's own page.
No login, protected download endpoint, account or authentication bypass is used.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
import imageio_ffmpeg
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MAPPINGS = ROOT / 'prisma/sources/public-exercise-media-mappings.json'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev/public-media-review'
CACHE = Path(tempfile.gettempdir()) / 'exercise-public-media'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def inspect(item):
    name, decision = item
    url = urllib.parse.urlparse(decision['sourceUrl'])
    is_wger = decision['provider'] == 'wger'
    if is_wger:
        if url.scheme != 'https' or url.hostname != 'wger.de' or not re.fullmatch(r'/api/v2/video/\d+/', url.path):
            raise RuntimeError('Unsupported licensed publisher URL')
    elif decision['provider'] != 'dvids' or url.scheme != 'https' or url.hostname != 'www.dvidshub.net' or not re.match(r'/video/\d+/', url.path):
        raise RuntimeError('Unsupported public publisher URL')
    source_id = 'wger-' + url.path.split('/')[-2] if is_wger else url.path.split('/')[2]
    page_file = OUTPUT / (source_id + '-page.html')
    with urllib.request.urlopen(decision['sourceUrl'], timeout=25) as response:
        page = response.read()
    html = page.decode('utf-8')
    if is_wger:
        record = json.loads(html)
        retained = next(row for row in json.loads((ROOT / 'prisma/sources/wger-video.json').read_text(encoding='utf-8'))['results'] if row['id'] == record['id'])
        if record['license'] != 2 or decision['rights'] != 'cc_by_sa_4' or any(record[key] != retained[key] for key in ['video', 'exercise', 'license', 'license_author']) or record['license_author'] != decision['author']:
            raise RuntimeError('Licensed source provenance changed for ' + name)
        media_url = record['video']
    else:
        if 'PUBLIC DOMAIN' not in html or decision['sourceTitle'] not in html:
            raise RuntimeError('Missing individual public-domain/title evidence for ' + name)
        media = re.findall(r'https[^\s\"\x27<>]+\.mp4[^\s\"\x27<>]*', html)
        if not media:
            raise RuntimeError('No public playback file for ' + name)
        media_url = media[0]
    parsed = urllib.parse.urlparse(media_url)
    allowed_host = 'wger.de' if is_wger else 'd34w7g4gy10iej.cloudfront.net'
    if parsed.scheme != 'https' or parsed.hostname != allowed_host or parsed.query:
        raise RuntimeError('Unexpected public playback host')
    page_file.write_bytes(page)
    source = CACHE / (source_id + '.mp4')
    if not source.exists():
        with urllib.request.urlopen(media_url, timeout=40) as response:
            if not response.headers.get_content_type().startswith('video/'):
                raise RuntimeError('Unexpected video content type')
            source.write_bytes(response.read())
    reader = imageio_ffmpeg.read_frames(str(source))
    metadata = next(reader)
    reader.close()
    duration = metadata['duration']
    times = [round(duration * fraction, 2) for fraction in [0.05, 0.2, 0.35, 0.5, 0.65, 0.8]]
    sheet = Image.new('RGB', (960, 315 * 3), 'white')
    draw = ImageDraw.Draw(sheet)
    for index, seconds in enumerate(times):
        image_file = CACHE / f'{source_id}-{index}.jpg'
        result = subprocess.run([FFMPEG, '-v', 'error', '-y', '-ss', str(seconds), '-i', str(source),
                                 '-frames:v', '1', '-vf', 'scale=480:-2', str(image_file)], capture_output=True)
        if result.returncode:
            raise RuntimeError('Frame extraction failed')
        image = Image.open(image_file)
        left, top = index % 2 * 480, index // 2 * 315
        draw.text((left + 5, top + 4), name + ' - ' + str(seconds) + 's', fill='black')
        sheet.paste(image, (left, top + 28))
    sheet.save(OUTPUT / (source_id + '-contact-sheet.jpg'))
    return name, {**decision, 'sourceId': source_id, 'publicPlaybackUrl': media_url,
                  'sourcePageSha256': hashlib.sha256(page).hexdigest(), 'sourceVideoSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                  'sourceDurationSeconds': duration, 'sourceDimensions': metadata['size'], 'framesSampledSeconds': times,
                  'localSource': str(source)}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    decisions = json.loads(MAPPINGS.read_text(encoding='utf-8'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        result = dict(pool.map(inspect, decisions.items()))
    (ROOT / 'prisma/sources/public-exercise-media-provenance.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({name: {'duration': row['sourceDurationSeconds'], 'dimensions': row['sourceDimensions']} for name, row in result.items()}))


if __name__ == '__main__':
    main()
