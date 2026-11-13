"""Propose strict title matches from known channels; outputs review data only."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'


def normalized(value):
    value = re.split(r'\s[|\u2013\u2014]\s|\s-\s', value)[0].lower().replace('bodybuilding.com', '')
    value = re.sub(r'\b(one|single)[ -]arm\b', 'unilateralarm', value)
    value = re.sub(r'\b(one|single)[ -]leg\b', 'unilateralleg', value)
    value = value.replace('push-ups', 'pushups').replace('pull-ups', 'pullups').replace('flyes', 'fly').replace('biceps', 'bicep').replace('triceps', 'tricep')
    stop = {'how', 'to', 'do', 'a', 'an', 'the', 'properly', 'perform', 'correctly', 'proper', 'form', 'technique', 'tutorial', 'guide', 'exercise', 'exercises', 'use', 'with', 'and'}
    words = [re.sub(r'^(curl|raise|extension|row|squat|lunge|dip|pushup|pullup)s$', r'\1', word)
             for word in re.findall('[a-z0-9]+', value) if word not in stop]
    return ' '.join(sorted(words))


def main():
    read = lambda file: json.loads((PRISMA / file).read_text(encoding='utf-8'))
    allowed = {row['channelName'].strip() for row in read('sources/reviewed-tutorial-metadata.json').values()}
    catalogue = {row['name']: row for row in read('exerciseCatalogue.json')}
    sources = read('exerciseSources.json')
    rows = json.loads((OUTPUT / 'all-tutorial-candidates.json').read_text(encoding='utf-8'))
    proposals = []
    for row in rows:
        exercise = catalogue[row['exercise']]
        aliases = [exercise['name']] + exercise.get('aliases', []) + [sources.get(exercise['name'], {}).get('sourceName', '')]
        keys = {normalized(alias) for alias in aliases if alias}
        for video in row['candidates']:
            if video['channel'].strip() not in allowed or not re.search(r'how to|tutorial|exercise guide|form.*technique', video['title'], re.I):
                continue
            if normalized(video['title']) not in keys:
                continue
            parts = video['duration'].split(':')
            if not all(part.isdigit() for part in parts):
                continue
            seconds = 0
            for part in parts:
                seconds = seconds * 60 + int(part)
            if not 25 <= seconds <= 1200:
                continue
            proposals.append({'exercise': row['exercise'], 'equipment': exercise['equipment'], **video,
                              'canonicalSetup': sources.get(exercise['name'], {}).get('instructions', [])[:2],
                              'status': 'requires_variant_review'})
            break
    (OUTPUT / 'exact-tutorial-proposals.json').write_text(json.dumps(proposals, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'searches': len(rows), 'strictCandidates': len(proposals)}))


if __name__ == '__main__':
    main()
