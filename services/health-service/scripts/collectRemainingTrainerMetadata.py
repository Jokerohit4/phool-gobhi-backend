"""Inspect primary descriptions for remaining trainer candidates. No publishing."""
import concurrent.futures
import json
from pathlib import Path
from buildReviewedExerciseTutorials import metadata
from collectTrainerTutorialReview import CHANNELS

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'


def main():
    read = lambda path: json.loads(path.read_text(encoding='utf-8'))
    existing = {row['exercise'] for row in read(PRISMA / 'exerciseVideos.json')}
    channels = CHANNELS | {row['channelName'] for row in read(PRISMA / 'sources/reviewed-tutorial-metadata.json').values()}
    channels -= {'OriGym', 'The Active Life', 'CrossFit'}
    grouped = {}
    for name in ['all-tutorial-candidates.json', 'primary-trainer-searches.json']:
        for row in read(OUTPUT / name):
            if row['exercise'] not in existing:
                grouped.setdefault(row['exercise'], []).extend(row['candidates'])
    proposed = []
    for exercise, videos in grouped.items():
        selected = {}
        for video in videos:
            parts = video['duration'].split(':')
            if video['channel'] not in channels or not parts or not all(part.isdigit() for part in parts):
                continue
            duration = 0
            for part in parts:
                duration = duration * 60 + int(part)
            if 25 <= duration <= 3600:
                selected.setdefault(video['id'], video)
        if selected:
            proposed.append({'exercise': exercise, 'candidates': list(selected.values())[:3]})
    (OUTPUT / 'remaining-trainer-metadata-proposals.json').write_text(json.dumps(proposed, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    cache_file = PRISMA / 'sources/remaining-trainer-candidate-metadata.json'
    cache = read(cache_file) if cache_file.exists() else {}
    prior = read(PRISMA / 'sources/trainer-tutorial-candidate-metadata.json')
    ids = sorted({video['id'] for row in proposed for video in row['candidates']})
    cache.update({video_id: prior[video_id] for video_id in ids if 'captionLanguages' in prior.get(video_id, {})})
    missing = [video_id for video_id in ids if video_id not in cache]
    print(json.dumps({'exercises': len(proposed), 'primaryChecks': len(missing)}), flush=True)

    def fetch(video_id):
        try:
            return video_id, metadata(video_id)
        except Exception:
            return video_id, {'youtubeVideoId': video_id, 'error': 'primary_metadata_unavailable'}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for i, (video_id, result) in enumerate(pool.map(fetch, missing), 1):
            cache[video_id] = result
            if i % 25 == 0:
                cache_file.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
                print('Remaining primary candidates checked:', i, flush=True)
    cache_file.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
