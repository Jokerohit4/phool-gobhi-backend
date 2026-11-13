"""Resume a small primary-metadata batch; save each result and stop on HTTP 429.

Input is an explicitly selected JSON name-to-video-ID map. This only collects
research evidence; it never approves or publishes a tutorial.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.error
from buildReviewedExerciseTutorials import metadata

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'prisma/sources/trainer-tutorial-candidate-metadata.json'
REPORT = ROOT.parents[1] / 'docs/exercise-dev/tutorial-verification-resume.json'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('--limit', type=int, default=12)
    parser.add_argument('--pause', type=float, default=5)
    args = parser.parse_args()
    assert 1 <= args.limit <= 20 and args.pause >= 5
    choices = json.loads(args.input.read_text(encoding='utf-8'))
    cache = json.loads(CACHE.read_text(encoding='utf-8'))
    checked, skipped = [], 0
    for video_id in dict.fromkeys(choices.values()):
        if cache.get(video_id, {}).get('oembedAvailable') and 'captionLanguages' in cache[video_id]:
            skipped += 1
            continue
        if len(checked) >= args.limit:
            break
        if checked:
            time.sleep(args.pause)
        try:
            row = metadata(video_id)
            cache[video_id] = row
            CACHE.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            checked.append({'youtubeVideoId': video_id, 'status': 'verified'})
            print(json.dumps({key: row[key] for key in ['youtubeVideoId', 'title', 'channelName', 'durationSeconds', 'captionLanguages', 'playabilityStatus', 'embeddable']}), flush=True)
        except urllib.error.HTTPError as error:
            checked.append({'youtubeVideoId': video_id, 'httpStatus': error.code})
            print(json.dumps(checked[-1]), flush=True)
            if error.code == 429:
                break
        except Exception as error:
            checked.append({'youtubeVideoId': video_id, 'errorType': type(error).__name__})
            print(json.dumps(checked[-1]), flush=True)
    REPORT.write_text(json.dumps({'checkedAt': datetime.now(timezone.utc).isoformat(),
        'input': args.input.name, 'cachedSkipped': skipped, 'results': checked,
        'rateLimited': any(row.get('httpStatus') == 429 for row in checked),
        'published': False}, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
