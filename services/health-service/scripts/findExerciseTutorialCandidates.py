"""Collect public YouTube search metadata for review; never publishes candidates.

Searches only the selected catalogue names. Requires no API key or login.
Every candidate still needs movement, language and availability review.
"""
import concurrent.futures
import json
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'
APP = ROOT.parents[2] / 'phool-gobhi-customer-app'


def search(exercise):
    query = exercise.get('searchQuery') or exercise['name'] + ' ' + exercise['equipment'] + ' exercise how to proper form'
    url = 'https://www.youtube.com/results?search_query=' + urllib.parse.quote(query)
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            html = response.read().decode('utf-8')
        match = re.search(r'var ytInitialData\s*=\s*({.*?});</script>', html)
        data = json.loads(match[1])
        videos = []

        def text(value):
            return value.get('simpleText') or ''.join(run.get('text', '') for run in value.get('runs', []))

        def walk(value):
            if isinstance(value, dict):
                if 'videoRenderer' in value:
                    video = value['videoRenderer']
                    videos.append({'id': video.get('videoId'), 'title': text(video.get('title', {})),
                                   'channel': text(video.get('ownerText', {})), 'duration': text(video.get('lengthText', {})),
                                   'description': text(video.get('descriptionSnippet', {}))})
                for item in value.values():
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)
        walk(data)
        return {'exercise': exercise['name'], 'equipment': exercise['equipment'], 'queryUrl': url, 'candidates': videos[:20]}
    except urllib.error.HTTPError as error:
        return {'exercise': exercise['name'], 'equipment': exercise['equipment'], 'queryUrl': url, 'candidates': [], 'error': 'public_search_unavailable', 'httpStatus': error.code}
    except Exception:
        return {'exercise': exercise['name'], 'equipment': exercise['equipment'], 'queryUrl': url, 'candidates': [], 'error': 'public_search_unavailable'}


def main():
    catalogue = json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))
    existing = json.loads((ROOT / 'prisma/exerciseVideos.json').read_text(encoding='utf-8'))
    names = set(re.findall(r"StarterExerciseSeed\(\s*'([^']+)'", (APP / 'lib/data/workout/starter_templates.dart').read_text(encoding='utf-8')))
    destination = OUTPUT / ('all-tutorial-candidates.json' if '--all' in sys.argv else 'tutorial-candidates.json')
    cached = json.loads(destination.read_text(encoding='utf-8')) if destination.exists() else []
    completed = {row['exercise'] for row in cached if row.get('candidates')}
    selected = [row for row in catalogue if ('--all' in sys.argv or row['name'] in names)
                and row['name'] not in {v['exercise'] for v in existing} and row['name'] not in completed]
    rows = [row for row in cached if row.get('candidates')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row in pool.map(search, selected):
            rows.append(row)
            if len(rows) % 25 == 0:
                OUTPUT.mkdir(parents=True, exist_ok=True)
                destination.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding='utf-8')
                print('Candidate searches completed:', len(rows), flush=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'searched': len(rows), 'withCandidates': sum(bool(row['candidates']) for row in rows)}, ensure_ascii=True))


if __name__ == '__main__':
    main()
