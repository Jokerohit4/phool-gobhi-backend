"""Resolve explicitly selected public instructional references from primary metadata.

Retains the actual title, channel, duration, source URL and per-video verification.
Never downloads, hosts or relicenses footage. Search results are not auto-published.
"""
import concurrent.futures
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'


def metadata(video_id):
    url = 'https://www.youtube.com/watch?v=' + video_id
    with urllib.request.urlopen(url, timeout=25) as response:
        html = response.read().decode('utf-8')
    marker = re.search(r'var ytInitialPlayerResponse\s*=\s*', html)
    if not marker:
        raise RuntimeError('Missing primary player metadata for ' + video_id)
    data, _ = json.JSONDecoder().raw_decode(html[marker.end():])
    video = data.get('videoDetails', {})
    if video.get('videoId') != video_id or not int(video.get('lengthSeconds', 0)) or video.get('isLiveContent'):
        raise RuntimeError('Missing duration or invalid reference for ' + video_id)
    oembed_url = 'https://www.youtube.com/oembed?format=json&url=' + urllib.parse.quote(url, safe='')
    with urllib.request.urlopen(oembed_url, timeout=20) as response:
        embedded = json.load(response)
    if embedded['title'] != video['title']:
        raise RuntimeError('Primary metadata disagrees for ' + video_id)
    return {'youtubeVideoId': video_id, 'title': video['title'], 'channelName': video['author'],
            'channelId': video.get('channelId'), 'durationSeconds': int(video['lengthSeconds']),
            'captionLanguages': [track.get('languageCode') for track in data.get('captions', {}).get('playerCaptionsTracklistRenderer', {}).get('captionTracks', [])],
            'sourceUrl': url, 'description': video.get('shortDescription', ''),
            'playabilityStatus': data.get('playabilityStatus', {}).get('status'),
            'embeddable': data.get('playabilityStatus', {}).get('playableInEmbed'),
            'oembedAvailable': True, 'verifiedAt': datetime.now(timezone.utc).isoformat()}


def main():
    mappings = json.loads((PRISMA / 'sources/reviewed-tutorial-mappings.json').read_text(encoding='utf-8'))
    old = json.loads((PRISMA / 'exerciseVideos.json').read_text(encoding='utf-8'))
    ids = sorted(set(mappings.values()) | {row['youtubeVideoId'] for row in old if row['exercise'] not in mappings})
    metadata_file = PRISMA / 'sources/reviewed-tutorial-metadata.json'
    # Reuse today's retained verification; --refresh explicitly rechecks every ID.
    cached = json.loads(metadata_file.read_text(encoding='utf-8')) if metadata_file.exists() and time.time() - metadata_file.stat().st_mtime < 86400 and '--refresh' not in sys.argv else {}
    source = {video_id: cached[video_id] for video_id in ids if cached.get(video_id, {}).get('oembedAvailable')}
    missing = [video_id for video_id in ids if video_id not in source]
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        source.update(zip(missing, pool.map(metadata, missing)))
    result = []
    replacements = []
    for row in old:
        selected = mappings.get(row['exercise'], row['youtubeVideoId'])
        if selected != row['youtubeVideoId']:
            replacements.append({'exercise': row['exercise'], 'oldId': row['youtubeVideoId'], 'newId': selected})
        result.append({'exercise': row['exercise'], **{key: source[selected][key] for key in ['youtubeVideoId', 'title', 'channelName', 'durationSeconds']}})
    existing = {row['exercise'] for row in result}
    for exercise, selected in mappings.items():
        if exercise not in existing:
            result.append({'exercise': exercise, **{key: source[selected][key] for key in ['youtubeVideoId', 'title', 'channelName', 'durationSeconds']}})
    (PRISMA / 'sources/reviewed-tutorial-metadata.json').write_text(json.dumps(source, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    (PRISMA / 'exerciseVideos.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    # Retain earlier replacements so repeated builds remain idempotent against an older dev DB.
    replacement_file = PRISMA / 'exerciseTutorialReplacements.json'
    previous = json.loads(replacement_file.read_text(encoding='utf-8')) if replacement_file.exists() else []
    for row in replacements:
        if row not in previous:
            previous.append(row)
    replacement_file.write_text(json.dumps(previous, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'tutorials': len(result), 'newExercises': len(result) - len(old), 'replacedReferences': len(replacements),
                      'oembedVerified': len(source), 'note': 'Primary source metadata verified; physical device playback remains a separate check.'}))


if __name__ == '__main__':
    main()
