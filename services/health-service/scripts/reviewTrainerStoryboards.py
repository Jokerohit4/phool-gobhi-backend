"""Inspect public publisher seek previews for setup review; no video rehosting."""
import concurrent.futures
import io
import json
from pathlib import Path
import re
import sys
import urllib.request
import urllib.error
import time
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev/reference-review'
TARGETS = {
    'High plank / Well+Good': 'u6ZelKyUM6g',
    'Double KB clean press / Kings': 'tCgwaQEY5bI',
    'KB jerk / Zack': 'N6Rvg3EH8mM',
    'KB jerk / Kings': 'IR32hqinsRo',
    'Deep squat / Hinge Health': 'IHApHfNA2Ag',
    'Cossack / Marcus Filly': 'iyKPbKf2jik',
    'Dumbbell preacher / Physique': 'U77nfbV43uo',
    'Barbell preacher / Mens Health': 'Gydpcouclx8',
    'Suitcase carry / Buff Dudes': 'tNHdx7pmrGI',
    'Body triceps press / Bench': 'gtCNypYeQKY',
    'Cable shoulder press / Live Lean': 'aX8Hgk2zkQ0',
    'Landmine press / Squat University': 'gH7PDepHNck',
}
FOCUSED = {
    'Treadmill running / Well+Good': 'K6I24WgiiPw',
    'KB double clean press / Kings': 'tCgwaQEY5bI',
    'KB overhead triceps / Kings': 'qS5q6FgddTI',
    'Suitcase carry / Champion PT': '3RKKnZhhelE',
    'Belt squat / J2Fit': 'c6AtfEDcOyk',
    'Cable shoulder press / Physique': 'fBTGwHChaf4',
    'Cable incline triceps / Live Lean': 'yMpUbdgr6P8',
    'Chair low-back stretch / Baptist': 'oi4Dq7uZfEg',
    'Body triceps press / canonical alternative': 'gtCNypYeQKY',
    'Dumbbell raise / Front': 'CH9JzDStL3U',
    'OriGym annotated teaching check': 'MLfXovxCx6M',
    'Nuffield kettlebell pistol / lesson': 'n7Fh6vGaJ7Y',
}


def inspect(item):
    name, video_id = item
    try:
        with urllib.request.urlopen('https://www.youtube.com/watch?v=' + video_id, timeout=25) as response:
            html = response.read().decode()
        marker = re.search(r'var ytInitialPlayerResponse\s*=\s*', html)
        data, _ = json.JSONDecoder().raw_decode(html[marker.end():])
        spec = data.get('storyboards', {}).get('playerStoryboardSpecRenderer', {}).get('spec', '').split('|')
        assert len(spec) > 1
        level = len(spec) - 2
        width, height, count, columns, rows, interval, pattern, signature = spec[-1].split('#')
        width, height, count, columns, rows = map(int, [width, height, count, columns, rows])
        cache = {}
        frames = []
        for fraction in [.12, .35, .6, .85]:
            index = min(count - 1, int(count * fraction))
            sheet = index // (columns * rows)
            if sheet not in cache:
                url = spec[0].replace('$L', str(level)).replace('$N', pattern.replace('$M', str(sheet))) + '&sigh=' + signature
                with urllib.request.urlopen(url, timeout=20) as response:
                    cache[sheet] = Image.open(io.BytesIO(response.read())).convert('RGB')
            position = index % (columns * rows)
            x, y = (position % columns) * width, (position // columns) * height
            frames.append(cache[sheet].crop((x, y, x + width, y + height)).resize((240, 135)))
        return name, video_id, frames, None
    except urllib.error.HTTPError as error:
        return name, video_id, [], 'HTTP' + str(error.code)
    except Exception as error:
        return name, video_id, [], type(error).__name__


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if '--origym' in sys.argv:
        prefix = sys.argv[sys.argv.index('--prefix') + 1] if '--prefix' in sys.argv else 'origym-trainer-review'
        if not re.fullmatch('[a-z0-9-]+', prefix):
            raise ValueError('Invalid local review prefix')
        proposals = json.loads((OUTPUT.parent / 'trainer-tutorial-proposals.json').read_text(encoding='utf-8'))
        targets = [(row['exercise'] + ' / ' + row['equipment'], video['id']) for row in proposals
                   if (video := next((video for video in row['candidates'] if video['channel'] == 'OriGym'), None))]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            inspected = list(pool.map(inspect, targets))
        font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 17)
        manifest = []
        for batch_start in range(0, len(inspected), 12):
            batch = inspected[batch_start:batch_start + 12]
            contact = Image.new('RGB', (960, 170 * len(batch)), '#16232a')
            draw = ImageDraw.Draw(contact)
            file = f'{prefix}-{batch_start // 12 + 1}.jpg'
            for row_index, (name, video_id, frames, error) in enumerate(batch):
                draw.text((8, row_index * 170 + 5), f'{name} | {video_id}' + (f' | unavailable: {error}' if error else ''), font=font, fill='white')
                for index, frame in enumerate(frames):
                    contact.paste(frame, (index * 240, row_index * 170 + 30))
                manifest.append({'name': name, 'youtubeVideoId': video_id, 'previewFrames': len(frames), 'error': error, 'contactSheet': file, 'reviewStatus': 'pending'})
            contact.save(OUTPUT / file, quality=94)
        (OUTPUT / (prefix + '.json')).write_text(json.dumps(manifest, indent=2) + '\n')
        print(json.dumps({'candidates': len(manifest), 'available': sum(not row['error'] for row in manifest)}))
        return
    targets = FOCUSED if '--focused' in sys.argv else TARGETS
    prefix = 'trainer-focused-contact' if '--focused' in sys.argv else 'trainer-setup-contact'
    if '--input' in sys.argv:
        input_path = Path(sys.argv[sys.argv.index('--input') + 1])
        targets = json.loads(input_path.read_text(encoding='utf-8'))
        prefix = input_path.stem + '-contact'
    contact = Image.new('RGB', (960, 170 * len(targets)), '#16232a')
    draw = ImageDraw.Draw(contact)
    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 19)
    manifest = []
    def inspected_targets():
        if '--slow' in sys.argv:
            for index, target in enumerate(targets.items()):
                if index:
                    time.sleep(5)
                result = inspect(target)
                yield result
                if result[3] == 'HTTP429':
                    break
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                yield from pool.map(inspect, targets.items())

    for row_index, (name, video_id, frames, error) in enumerate(inspected_targets()):
            draw.text((8, row_index * 170 + 5), f'{name} | {video_id}' + (f' | unavailable: {error}' if error else ''), font=font, fill='white')
            for index, frame in enumerate(frames):
                contact.paste(frame, (index * 240, row_index * 170 + 30))
            manifest.append({'name': name, 'youtubeVideoId': video_id, 'previewFrames': len(frames), 'error': error})
    contact.save(OUTPUT / (prefix + '.jpg'), quality=92)
    (OUTPUT / (prefix + '.json')).write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'videos': len(manifest), 'available': sum(not row['error'] for row in manifest)}))


if __name__ == '__main__':
    main()
