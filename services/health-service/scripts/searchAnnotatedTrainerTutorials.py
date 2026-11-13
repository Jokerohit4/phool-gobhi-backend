"""Search professional publisher's existing recorded, annotated exercise guides.

No publishing: every result still requires primary availability and visual setup
and explanatory-cue review. Never count a bare exercise loop as a tutorial.
"""
import concurrent.futures
import json
from pathlib import Path
from findExerciseTutorialCandidates import search

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'


def main():
    read = lambda name: json.loads((PRISMA / name).read_text(encoding='utf-8'))
    existing = {row['exercise'] for row in read('exerciseVideos.json')}
    pending = set(read('sources/trainer-tutorial-review-20261106.json')['selected'])
    destination = OUTPUT / 'origym-trainer-searches.json'
    cached = json.loads(destination.read_text(encoding='utf-8')) if destination.exists() else []
    completed = {row['exercise'] for row in cached if row.get('candidates')}
    sources = read('exerciseSources.json')
    rows = [row for row in cached if row.get('candidates')]
    selected = []
    for row in read('exerciseCatalogue.json'):
        if row['name'] in existing or row['name'] in pending or row['name'] in completed:
            continue
        name = sources.get(row['name'], {}).get('sourceName') or row['name']
        selected.append({**row, 'searchQuery': name + ' OriGym how to exercise'})

    def save():
        temporary = destination.with_suffix('.tmp')
        temporary.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        temporary.replace(destination)

    print(json.dumps({'newPublisherSearches': len(selected)}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row in pool.map(search, selected):
            rows.append(row)
            if len(rows) % 25 == 0:
                save()
                print('Annotated publisher searches:', len(rows), flush=True)
    save()
    print(json.dumps({'searched': len(rows), 'withCandidates': sum(bool(row['candidates']) for row in rows)}))


if __name__ == '__main__':
    main()
