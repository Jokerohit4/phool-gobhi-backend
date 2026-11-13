"""Fuzzy title ranking for human implementation review only. Never publishes."""
import difflib
import json
from pathlib import Path
import re
from collectTrainerTutorialReview import CHANNELS, normalized

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'


def main():
    read = lambda path: json.loads(path.read_text(encoding='utf-8'))
    sources = read(PRISMA / 'exerciseSources.json')
    catalogue = {row['name']: row for row in read(PRISMA / 'exerciseCatalogue.json')}
    existing = {row['exercise'] for row in read(PRISMA / 'exerciseVideos.json')}
    exact = {row['exercise'] for row in read(OUTPUT / 'narrated-trainer-review.json')}
    channels = CHANNELS | {row['channelName'] for row in read(PRISMA / 'sources/reviewed-tutorial-metadata.json').values()}
    rows = {}
    for path in [OUTPUT / 'all-tutorial-candidates.json', OUTPUT / 'primary-trainer-searches.json']:
        for row in read(path):
            rows.setdefault(row['exercise'], []).extend(row['candidates'])
    result = []
    for name, choices in rows.items():
        if name in existing or name in exact:
            continue
        exercise = catalogue[name]
        keys = [normalized(alias) for alias in [name, *exercise.get('aliases', []), sources.get(name, {}).get('sourceName', '')] if alias]
        candidates = {}
        for video in choices:
            if video['channel'] not in channels or video['channel'] in {'OriGym', 'The Active Life', 'CrossFit'}:
                continue
            parts = video['duration'].split(':')
            if not all(part.isdigit() for part in parts):
                continue
            duration = 0
            for part in parts:
                duration = duration * 60 + int(part)
            if not 25 <= duration <= 1200:
                continue
            title = re.split(r'\s[|\u2013\u2014]\s|\s-\s|\s\|\|\s', video['title'])[0]
            key = normalized(title)
            score = max(difflib.SequenceMatcher(None, alias, key).ratio() for alias in keys)
            if score >= .6:
                candidates[video['id']] = {**video, 'similarity': round(score, 3)}
        ordered = sorted(candidates.values(), key=lambda video: -video['similarity'])
        if ordered:
            result.append({'exercise': name, 'equipment': exercise['equipment'], 'setup': sources.get(name, {}).get('instructions', [])[:2], 'candidates': ordered[:3], 'status': 'requires_explicit_variant_decision'})
    (OUTPUT / 'variant-trainer-proposals.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'additionalProposals': len(result)}))


if __name__ == '__main__':
    main()
