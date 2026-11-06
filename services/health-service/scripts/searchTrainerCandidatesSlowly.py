"""Small resumable research searches. No candidate is auto-published."""
import argparse
import json
from pathlib import Path
import time
from findExerciseTutorialCandidates import search

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev/resumed-trainer-searches.json'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('--limit', type=int, default=8)
    args = parser.parse_args()
    assert 1 <= args.limit <= 20
    queries = json.loads(args.input.read_text(encoding='utf-8'))
    catalogue = {r['name']: r for r in json.loads((ROOT / 'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    existing = {r['exercise'] for r in json.loads((ROOT / 'prisma/exerciseVideos.json').read_text(encoding='utf-8'))}
    rows = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else []
    completed = {r['queryUrl'] for r in rows if r.get('candidates')}
    count = 0
    for name, query in queries.items():
        if name in existing:
            continue
        from urllib.parse import quote
        if 'https://www.youtube.com/results?search_query=' + quote(query) in completed:
            continue
        if count >= args.limit:
            break
        if count:
            time.sleep(5)
        row = search({**catalogue[name], 'searchQuery': query})
        rows.append(row)
        OUTPUT.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(json.dumps(row, ensure_ascii=True), flush=True)
        count += 1
        if row.get('httpStatus') == 429:
            break


if __name__ == '__main__':
    main()
