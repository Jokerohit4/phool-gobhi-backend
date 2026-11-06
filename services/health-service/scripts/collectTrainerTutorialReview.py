"""Collect conservative trainer tutorial matches and primary metadata for review.

Does not publish videos. Equipment/variant/language/teaching review is a separate
explicit decision; neither a matching title nor a working embed establishes it.
"""
import concurrent.futures
import json
from pathlib import Path
import re
import sys
from buildReviewedExerciseTutorials import metadata

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'
CHANNELS = {
    'Bodybuilding.com', 'ScottHermanFitness', 'PureGym', 'Muscle & Strength',
    'Live Lean TV Daily Exercises', 'National Academy of Sports Medicine (NASM)',
    'Catalyst Athletics', 'CrossFit', 'Mark Wildman', 'Squat University',
    'Renaissance Periodization', 'Colossus Fitness', 'Jeremy Ethier', 'Max Euceda',
    'Mind Pump TV', 'LIVESTRONG', 'LivestrongWoman', 'Well+Good', 'ATHLEAN-X™',
    'ATHLEAN-X�', 'The Active Life', 'TOROKHTIY', 'Runna', 'OriGym',
    'Jeff Nippard', 'Buff Dudes Workouts', 'The Bioneer', 'Baptist Health',
    'Fit Father Project - Fitness For Busy Fathers', 'BPI Sports', 'E3 Rehab',
    'E3 Rehab Exercises', 'Physiotutors', 'AskDoctorJo', 'Performance Health',
    'Precision Movement', 'Redefining Strength', 'HASfit', 'Nuffield Health',
    'FitnessBlender', 'Caroline Girvan', 'Lucy Wyndham-Read', 'CHRISTUS Health',
    'Testosterone Nation', 'T NATION', 'T Nation', 'ACE Fitness', 'ACE',
    'American Council on Exercise', 'Muscle and Motion', 'Starting Strength',
    'Alan Thrall', 'Barbell Medicine', 'BarBend', 'Girls Gone Strong',
    'GMB Fitness', 'Calisthenicmovement', 'FitnessFAQs', 'Tom Merrick',
    'Yoga With Adriene', 'Yoga with Kassandra', 'FightCamp', 'Tony Jeffries',
    'OPEX Fitness', 'Atomic Athlete', 'Zack Henderson', 'Jack Hanrahan Fitness ',
    'mountaindog1', 'Onnit', 'Rogue Fitness', 'Functional Bodybuilding', "Men's Health",
    'Tone and Tighten', 'Bupa Health', 'Hinge Health', 'www.sportsinjuryclinic.net',
    'eHowFitness', 'Tiger Fitness', 'CrossFit Invictus', 'StrongFirst', 'Rehab and Revive',
    'Peak Strength', 'Onnit Academy', 'Hospital for Special Surgery', 'Barbell Logic',
    'Criticalbench', 'Get Healthy U - with Chris Freytag', 'Kettlebell Kings',
    'Marcus Filly', 'Tom Morrison', 'Garage Strength', 'Buff Dudes', 'elitefts',
}


def normalized(value):
    value = value.lower().replace('push-ups', 'pushups').replace('push-up', 'pushup').replace('pull-ups', 'pullups').replace('pull-up', 'pullup').replace('sit-ups', 'situps').replace('sit-up', 'situp')
    value = re.sub(r'\b(one|single)[ -]arm\b', 'singlearm', value)
    value = re.sub(r'\b(one|single)[ -]leg\b', 'singleleg', value)
    value = value.replace('flyes', 'fly').replace('flies', 'fly').replace('triceps', 'tricep').replace('biceps', 'bicep')
    stop = {'how', 'to', 'do', 'a', 'an', 'the', 'properly', 'perform', 'correctly', 'proper', 'form', 'technique', 'tutorial', 'guide', 'exercise', 'exercises', 'with', 'and', 'perfect', 'correct', 'fitness', 'training', 'movement', 'demonstration', 'demo', 'learn', 'step', 'by', 'tutorials', 'strength', 'instructions'}
    words = [re.sub(r'^(curl|raise|extension|row|squat|lunge|dip|pushup|pullup|press|swing|situp|crunch|rotation|shrug|jump|kickback)s$', r'\1', word)
             for word in re.findall('[a-z0-9]+', value) if word not in stop]
    return ' '.join(sorted(words))


def main():
    read = lambda name: json.loads((PRISMA / name).read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in read('exerciseCatalogue.json')}
    sources = read('exerciseSources.json')
    existing = {row['exercise'] for row in read('exerciseVideos.json')}
    known_channels = CHANNELS | {row['channelName'] for row in read('sources/reviewed-tutorial-metadata.json').values()}
    searches = json.loads((OUTPUT / 'all-tutorial-candidates.json').read_text(encoding='utf-8'))
    by_name = {row['exercise']: row for row in searches}
    for additional in [OUTPUT / 'primary-trainer-searches.json', OUTPUT / 'origym-trainer-searches.json', OUTPUT / 'focused-trainer-searches.json']:
        if not additional.exists():
            continue
        for row in json.loads(additional.read_text(encoding='utf-8')):
            if row['exercise'] in by_name:
                known_ids = {video['id'] for video in by_name[row['exercise']]['candidates']}
                by_name[row['exercise']]['candidates'].extend(video for video in row['candidates'] if video['id'] not in known_ids)
            else:
                by_name[row['exercise']] = row
    searches = list(by_name.values())
    proposals = []
    for row in searches:
        if row['exercise'] in existing:
            continue
        exercise = catalogue[row['exercise']]
        aliases = [exercise['name'], *exercise.get('aliases', []), sources.get(exercise['name'], {}).get('sourceName', '')]
        keys = {normalized(alias) for alias in aliases if alias}
        choices = []
        for video in row['candidates']:
            parts = video['duration'].split(':')
            if not parts or not all(part.isdigit() for part in parts):
                continue
            duration = 0
            for part in parts:
                duration = duration * 60 + int(part)
            if not 25 <= duration <= 1200 or video['channel'] not in known_channels:
                continue
            title = re.split(r'\s[|\u2013\u2014]\s|\s-\s|\s\|\|\s', video['title'])[0]
            if normalized(title) not in keys:
                continue
            teaching = bool(re.search(r'how\s*to|tutorial|guide|technique|proper\s*form|correct\s*form', video['title'], re.I))
            choices.append({**video, 'teachingTitle': teaching})
        choices.sort(key=lambda video: (not video['teachingTitle'], -int(video['channel'] in CHANNELS)))
        if choices:
            proposals.append({'exercise': exercise['name'], 'equipment': exercise['equipment'],
                              'setup': sources.get(exercise['name'], {}).get('instructions', [])[:2],
                              'candidates': choices[:2], 'status': 'requires_trainer_and_variant_review'})
    (OUTPUT / 'trainer-tutorial-proposals.json').write_text(json.dumps(proposals, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'strictProposals': len(proposals), 'teachingTitles': sum(row['candidates'][0]['teachingTitle'] for row in proposals)}), flush=True)
    if '--metadata' not in sys.argv:
        return
    cache_file = PRISMA / 'sources/trainer-tutorial-candidate-metadata.json'
    cache = json.loads(cache_file.read_text(encoding='utf-8')) if cache_file.exists() else {}
    ids = sorted({video['id'] for row in proposals for video in row['candidates']})

    def fetch(video_id):
        if video_id in cache and cache[video_id].get('oembedAvailable') and 'captionLanguages' in cache[video_id]:
            return video_id, cache[video_id]
        try:
            return video_id, metadata(video_id)
        except Exception:
            return video_id, {'youtubeVideoId': video_id, 'error': 'primary_metadata_unavailable'}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for i, (video_id, result) in enumerate(pool.map(fetch, ids), 1):
            cache[video_id] = result
            if i % 25 == 0:
                cache_file.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
                print('Primary references checked:', i, flush=True)
    cache_file.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'primaryMetadata': len(cache), 'unavailable': sum(bool(row.get('error')) for row in cache.values())}))


if __name__ == '__main__':
    main()
