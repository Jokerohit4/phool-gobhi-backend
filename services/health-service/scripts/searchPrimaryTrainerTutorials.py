"""Search primary trainer publishers for missing tutorials; review only."""
import concurrent.futures
import json
from pathlib import Path
from findExerciseTutorialCandidates import search

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'


def main():
    read = lambda name: json.loads((ROOT / 'prisma' / name).read_text(encoding='utf-8'))
    sources = read('exerciseSources.json')
    existing = {row['exercise'] for row in read('exerciseVideos.json')}
    destination = OUTPUT / 'primary-trainer-searches.json'
    cached = json.loads(destination.read_text(encoding='utf-8')) if destination.exists() else []
    completed = {row['exercise'] for row in cached if row.get('candidates')}
    rows = [row for row in cached if row.get('candidates')]
    selected = []
    for row in read('exerciseCatalogue.json'):
        if row['name'] in existing or row['name'] in completed:
            continue
        source = sources.get(row['name'], {})
        query = (source.get('sourceName') or row['name']) + ' Bodybuilding.com exercise guide'
        if not source:
            query = row['name'] + ' how to exercise tutorial trainer English'
        selected.append({**row, 'searchQuery': query})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row in pool.map(search, selected):
            rows.append(row)
            if len(rows) % 25 == 0:
                destination.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
                print('Primary publisher searches:', len(rows), flush=True)
    destination.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'searches': len(rows), 'withCandidates': sum(bool(row['candidates']) for row in rows)}))


if __name__ == '__main__':
    main()
