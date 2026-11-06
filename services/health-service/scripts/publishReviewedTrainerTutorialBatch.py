"""Prepare reviewed trainer links for dev backfill. No external writes."""
import json
from pathlib import Path
from buildReviewedExerciseTutorials import main as build

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'


def main():
    read = lambda path: json.loads(path.read_text(encoding='utf-8'))
    review = read(PRISMA / 'sources/trainer-tutorial-review-20261106.json')
    catalogue = {row['name']: row for row in read(PRISMA / 'exerciseCatalogue.json')}
    candidate = read(PRISMA / 'sources/trainer-tutorial-candidate-metadata.json')
    mappings_path = PRISMA / 'sources/reviewed-tutorial-mappings.json'
    mappings = read(mappings_path)
    metadata_path = PRISMA / 'sources/reviewed-tutorial-metadata.json'
    verified = read(metadata_path)
    for name, row in review['selected'].items():
        assert name in catalogue and row['equipment'] == catalogue[name]['equipment']
        assert row['reviewType'] == 'primary_publisher_and_canonical_setup_review' and row['reason']
        video_id = row['youtubeVideoId']
        source = candidate[video_id]
        assert source['youtubeVideoId'] == video_id and source['playabilityStatus'] == 'OK'
        assert source['embeddable'] and source['oembedAvailable']
        assert source['title'] and source['channelName'] and source['durationSeconds'] >= 10
        if row.get('instructionFormat') == 'recorded_trainer_with_on_screen_steps':
            visual = read(PRISMA / 'sources/reviewed-annotated-trainer-tutorials-20261106.json')['selected'][name]
            assert visual['youtubeVideoId'] == video_id and visual['equipment'] == catalogue[name]['equipment']
            assert visual['previewFrames'] >= 4 and visual['language'] == 'en' and visual['reason']
        else:
            assert any(language.startswith('en') for language in source['captionLanguages'])
        assert name not in mappings or mappings[name] == video_id, 'Refusing an unreviewed replacement'
        mappings[name] = video_id
        verified[video_id] = source
    mappings_path.write_text(json.dumps(mappings, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    metadata_path.write_text(json.dumps(verified, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    build()


if __name__ == '__main__':
    main()
