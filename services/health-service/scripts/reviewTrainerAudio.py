"""Collect local speech evidence for explicitly selected public video references.

Research only: never approves a tutorial or uploads publisher media. Audio and
full machine transcripts stay in the task's private temporary directory. The
repo retains hashes, language/confidence metrics and a pending review status.
Uses the standard public client without cookies, tokens, proxies or client
switching. Stops on denied/rate-limited downloads.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import tempfile
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev/trainer-audio-candidates.json'
PRIVATE = Path(tempfile.gettempdir()) / 'exercise-audio-review'
sys.path.insert(0, str(Path(tempfile.gettempdir()) / 'exercise-audio-review-packages'))
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


class Quiet:
    def debug(self, message): pass
    def info(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('--limit', type=int, default=6)
    parser.add_argument('--max-duration', type=int, default=120)
    args = parser.parse_args()
    assert 1 <= args.limit <= 12
    assert 10 <= args.max_duration <= 600
    import numpy as np
    import yt_dlp
    import imageio_ffmpeg
    from faster_whisper import WhisperModel
    choices = json.loads(args.input.read_text(encoding='utf-8'))
    primary = json.loads((ROOT / 'prisma/sources/trainer-tutorial-candidate-metadata.json').read_text(encoding='utf-8'))
    cache = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {}
    PRIVATE.mkdir(exist_ok=True)
    model = WhisperModel('base', device='cpu', compute_type='int8', download_root=str(PRIVATE / 'models'), local_files_only=True)
    checked = 0
    for video_id in dict.fromkeys(choices.values()):
        assert re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id)
        if video_id in cache or checked >= args.limit:
            continue
        source = primary[video_id]
        assert source['playabilityStatus'] == 'OK' and source['embeddable'] and source['oembedAvailable']
        if source['durationSeconds'] > args.max_duration:
            continue
        if checked:
            time.sleep(5)
        row = {'youtubeVideoId': video_id, 'sourceUrl': source['sourceUrl'],
               'checkedAt': datetime.now(timezone.utc).isoformat(),
               'method': 'local_whisper_speech_verification', 'model': 'faster-whisper/base/cpu-int8',
               'reviewStatus': 'pending', 'mediaRehosted': False}
        denied = False
        try:
            options = {'format': 'bestaudio', 'outtmpl': str(PRIVATE / '%(id)s.%(ext)s'),
                       'quiet': True, 'no_warnings': True, 'noplaylist': True,
                       'retries': 0, 'fragment_retries': 0, 'extractor_retries': 0,
                       'socket_timeout': 15, 'logger': Quiet()}
            with yt_dlp.YoutubeDL(options) as downloader:
                info = downloader.extract_info(source['sourceUrl'], download=True)
                audio_file = Path(downloader.prepare_filename(info))
            wav_file = PRIVATE / (video_id + '.wav')
            # Decode locally to PCM: avoids PyAV API differences between releases.
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-i', str(audio_file),
                            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav_file)],
                           capture_output=True, check=True)
            with wave.open(str(wav_file), 'rb') as wav:
                audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768
            segments, info = model.transcribe(audio, beam_size=5, vad_filter=True, condition_on_previous_text=False)
            segments = list(segments)
            transcript = {'youtubeVideoId': video_id, 'segments': [
                {'start': s.start, 'end': s.end, 'text': s.text,
                 'noSpeechProbability': s.no_speech_prob, 'averageLogProbability': s.avg_logprob}
                for s in segments]}
            transcript_file = PRIVATE / (video_id + '-transcript.json')
            transcript_file.write_text(json.dumps(transcript, indent=2) + '\n', encoding='utf-8')
            words = ' '.join(s.text for s in segments).split()
            row.update(language=info.language, languageProbability=info.language_probability,
                       durationSeconds=info.duration, wordCount=len(words),
                       meanNoSpeechProbability=statistics.mean(s.no_speech_prob for s in segments) if segments else 1,
                       meanLogProbability=statistics.mean(s.avg_logprob for s in segments) if segments else -99,
                       audioSha256=hashlib.sha256(audio_file.read_bytes()).hexdigest(),
                       transcriptSha256=hashlib.sha256(transcript_file.read_bytes()).hexdigest())
        except Exception as error:
            message = str(error).lower()
            row.update(errorType=type(error).__name__, http429='429' in message,
                       http403='403' in message, requiresLogin='sign in' in message or 'not a bot' in message)
            denied = row['http429'] or row['http403'] or row['requiresLogin']
        cache[video_id] = row
        OUTPUT.write_text(json.dumps(cache, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(row), flush=True)
        checked += 1
        if denied:
            break


if __name__ == '__main__':
    main()
