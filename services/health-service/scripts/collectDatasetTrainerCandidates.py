"""Collect exact exercise/equipment matches from a pinned reference dataset.

Output is candidate metadata only: source labels are not evidence that a video
is narrated, actually depicts the variant, or is suitable as a tutorial.
"""
import concurrent.futures
import json
from pathlib import Path
from buildReviewedExerciseTutorials import metadata
from collectTrainerTutorialReview import normalized

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'


def main():
    read = lambda name: json.loads((PRISMA / name).read_text(encoding='utf-8'))
    sources = read('exerciseSources.json')
    existing = {row['exercise'] for row in read('exerciseVideos.json')}
    reference = read('sources/workout-database.json')
    equipment = {'barbell': 'barbell', 'ez_bar': 'barbell', 'dumbbells': 'dumbbell', 'machine': 'machine', 'cable': 'cable', 'kettlebell': 'kettlebell', 'bodyweight': 'bodyweight', 'monkey_bars': 'bodyweight'}
    proposed = []
    for row in read('exerciseCatalogue.json'):
        if row['name'] in existing:
            continue
        keys = {normalized(name) for name in [row['name'], *row.get('aliases', []), sources.get(row['name'], {}).get('sourceName', '')] if name}
        for source in reference:
            if normalized(source['exercise_name']['en']) not in keys:
                continue
            if equipment.get(source['material']['id'], 'other') != row['equipment']:
                continue
            videos = [video for video in source.get('media', {}).get('videos', []) if video.get('language') == 'en'
                      and (video.get('type') == 'standard' or video.get('duration_seconds', 0) >= 45)]
            if videos:
                proposed.append({'exercise': row['name'], 'equipment': row['equipment'], 'sourceId': source['id'], 'sourceName': source['exercise_name']['en'], 'sourceInstructions': source.get('instructions', {}).get('en', []), 'videos': videos[:2]})
    (OUTPUT / 'dataset-trainer-proposals.json').write_text(json.dumps(proposed, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    cache_file = PRISMA / 'sources/dataset-trainer-candidate-metadata.json'
    cache = read('sources/dataset-trainer-candidate-metadata.json') if cache_file.exists() else {}
    ids = sorted({video['youtube_id'] for row in proposed for video in row['videos']})
    missing = [video_id for video_id in ids if 'captionLanguages' not in cache.get(video_id, {})]
    print(json.dumps({'proposals': len(proposed), 'newPrimaryChecks': len(missing)}), flush=True)

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
                print('Dataset references checked:', i, flush=True)
    cache_file.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
