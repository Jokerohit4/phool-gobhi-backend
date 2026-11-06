"""Search the original catalogue's remaining exact setups. Candidate-only."""
import concurrent.futures
import json
from pathlib import Path
from findExerciseTutorialCandidates import search

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'
SPECIAL = {
    'Cable Kickback': 'cable glute kickback proper form trainer tutorial',
    'Pike Push-up': 'pike push up FitnessFAQs tutorial',
    'Knee Push-up': 'knee push up HASfit tutorial',
    'Archer Push-up': 'archer push up FitnessFAQs tutorial',
    'Machine Low Row': 'low row machine form tutorial trainer',
    'Back Extension': 'seated back extension machine how to trainer',
    'Single-Arm Dumbbell Press': 'single arm dumbbell overhead shoulder press tutorial',
    'Prone Y Raise': 'prone Y raise no weight physical therapist tutorial',
    'Prone T Raise': 'prone T raise no weight physical therapist tutorial',
    'High Plank': 'high straight arm plank Well Good Traci tutorial',
    'Bear Plank': 'bear plank Well Good Traci tutorial',
    'Dumbbell Triceps Extension': 'single arm overhead dumbbell tricep extension tutorial',
    'Kettlebell Clean and Press': 'double kettlebell clean and press tutorial Kettlebell Kings',
    'Seated Hamstring Stretch': 'seated floor hamstring stretch one leg tutorial physical therapist',
    'Stability Ball Rollout': 'kneeling stability ball rollout proper form tutorial',
    'Kettlebell Romanian Deadlift': 'kettlebell Romanian deadlift proper form tutorial',
}


def main():
    read = lambda name: json.loads((ROOT / 'prisma' / name).read_text(encoding='utf-8'))
    existing = {row['exercise'] for row in read('exerciseVideos.json')}
    destination = OUTPUT / 'focused-trainer-searches.json'
    cached = json.loads(destination.read_text(encoding='utf-8')) if destination.exists() else []
    completed = {row['exercise'] for row in cached if row.get('candidates')}
    selected = []
    for row in read('exerciseCatalogue.json')[:308]:
        if row['name'] in existing or row['name'] in completed:
            continue
        selected.append({**row, 'searchQuery': SPECIAL.get(row['name'], row['name'] + ' how to proper technique trainer tutorial')})
    result = [row for row in cached if row.get('candidates')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row in pool.map(search, selected):
            result.append(row)
    destination.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'focusedSearches': len(result)}))


if __name__ == '__main__':
    main()
