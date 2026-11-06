"""Materialize explicit implementation review decisions; retain actual metadata.

No source videos are downloaded or rehosted. Missing English narration evidence,
unavailable embeds and rejected variant substitutions stay out of the app.
"""
import concurrent.futures
from datetime import datetime, timezone
import json
from pathlib import Path
from buildReviewedExerciseTutorials import metadata

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
OUTPUT = ROOT.parents[1] / 'docs/exercise-dev'
EXCLUDED = {
    'Kettlebell Clean and Press': 'Candidate teaches one kettlebell; current guide/reference uses two.',
    'Seated Hamstring Stretch': 'Chair-based candidate differs from the canonical floor stretch.',
    'Ankle Circles': 'Candidate uses a supported supine ankle; canonical reference stands with support.',
    'Chair Squat': 'Bodyweight chair exercise does not match the canonical Smith-machine exercise.',
    'Split Squat Stretch': 'Weighted split squat is not the canonical jumping alternating split stretch.',
    'Dumbbell Triceps Extension': 'Generic extension title does not establish the canonical standing single-arm setup.',
    'Back Extension': 'Generic bench-extension candidate does not establish the canonical seated machine setup.',
}
# Exact choices after title/setup/equipment review; never inferred from a fuzzy
# score. A further primary-language/availability gate below can withhold them.
ADDITIONAL = {
    'Neutral-Grip Pull-up': 'tSRo8ksP27I',
    'Single-Leg Squat to Bench': '8twCe4C0c1c',
    'Machine Triceps Extension': 'NNyuuN2sJb0',
    'Assisted Dip': 'kbmVlw-i0Vs',
    'Stability Ball Rollout': 'lyMJClJQl-8',
    'Kettlebell Clean and Press': 'xHDRoJfDTfE',
    'Dumbbell Devil Press': 'gaVoxC7RV_8',
    'Cable Fly': '4Y8QgiT2-OA',
    'Single-Arm Cable Row': '_z5NMUxkxxw',
    'Cable Lateral Raise': 'qitQHqNZbeM',
    'Cable Upright Row': 'FfyheD6NZvU',
    'Cable Curl': 'NFzTWp2qpiE',
    'Cable Woodchopper': 'GwxbI7hnnwI',
    'Barbell Floor Press': 'vAFw7EPL4eM',
    'Decline Dumbbell Press': 'Pf1nDoqx_1A',
    'Dumbbell Pullover': '5YStMv6m2g8',
    'Dumbbell Squeeze Press': 'rHfxaP0iF1E',
    'Incline Machine Chest Press': 'VesHgJR14E8',
    'Pec Deck Fly': 'H4mVGHaK2f4',
    'Smith Machine Incline Press': 'b8DqTO6ak0k',
    'Wide Push-up': 'rr6eFNNDQdU',
    'Scapular Push-up': 'LeMk15TN0No',
    'T-Bar Row': 'KDEl3AmZbVE',
    'Rack Pull': 'aAjN8zS7Idg',
    'Close-Grip Lat Pulldown': 'OTkdHxxAjt8',
    'Underhand Lat Pulldown': 'apzFTbsm7HU',
    'Cable Pullover': '32auHIqgEoM',
    'Assisted Pull-up': 'wFj808u2HWU',
    'Machine High Row': 'beKbbq6NhWY',
    'Chest-Supported Machine Row': 'TeFo51Q_Nsc',
    'Reverse Pec Deck': 'dC7jhEk-29A',
    'Stiff-Leg Deadlift': '1uDiW5--rAE',
    'Barbell Good Morning': 'lYUB78Btcxc',
    'Box Squat': 'Jrmd2z8ul64',
    'Dumbbell Step-up': '7AtIjR-QqVA',
    'Single-Leg Romanian Deadlift': 'Zfr6wizR8rs',
    'Hip Abduction Machine': 'h9BqUMqK-SY',
    'Hip Adduction Machine': 'GmRSV_n2E_0',
    'Machine Hip Thrust': 'tztHvSLdXLA',
    'Lateral Lunge': '4NlJdSzHeUg',
    'Step-up': '91xCEkwXxv0',
    'Nordic Hamstring Curl': '_e9vFU9-tkc',
    'Seated Calf Raise': '6O5hh1rBtx8',
    'Leg Press Calf Raise': 'PYZY00hI43w',
    'Machine Shoulder Press': '3R14MnZbcpw',
    'Machine Lateral Raise': 'NNAs8jx_zJI',
    'Smith Machine Shoulder Press': 'aKWQrB8afy0',
    'Wall Slide': 'GLty-L_JxXk',
    'Triceps Kickback': '6SS6K3lAwZ8',
    'Single-Arm Overhead Triceps Extension': '2jl4M0Dnq4c',
    'EZ-Bar Skull Crusher': 'd_KZxkY_0cM',
    'Barbell Triceps Extension': '4re6CJ0XNF8',
    'Cable Triceps Kickback': 'Rmi70NbBv24',
    'High Cable Curl': 'Okl64XegSu0',
    'Machine Preacher Curl': 'AR-oARBkYxI',
    'Crunch': '0t4t3IpiEao',
    'Flutter Kick': 'vHxbqt9ApdM',
    'Hanging Knee Raise': 'fLbZrF6MZuE',
    'Captain Chair Knee Raise': '7KDDZtaUaxw',
    'Plank Shoulder Tap': 'wcKyqAMqueQ',
    'Cable Rotation': '61ara6KJdrU',
    'Ab Wheel Rollout': 'nCh8VfWY5_g',
    'Stability Ball Crunch': 'Imui46JTe7s',
    'Medicine Ball Russian Twist': 'mCViD-Ui-4o',
    'Butt Kick': '-dtvAxibgYQ',
    'Incline Treadmill Walk': 'NAsObfFJXvE',
    'Recumbent Bike': 'XugMoMDxyhM',
    'Stair Climber': '6eMPlQ95gXI',
    'Air Bike': 'YJdvEpTKpXk',
    'Squat Thrust': 'F1kVWDpH6co',
    'Kettlebell Clean': 'MYpz7OykS7I',
    'Kettlebell Thruster': 'Mr-l0Kvowi4',
    'Farmer Carry': 'lLAw6fUccKA',
    'Wrist Flexor Stretch': 'i-JV2PsFzWA',
    'Arm Circles': '140RTNMciH8',
    'Band Skull Crusher': 'xtb-gltsmMU',
    'Barbell Ab Rollout - On Knees': 'mIYuVpQF3N8',
    'Barbell Full Squat': 'tVB1q8zkP3o',
    'Barbell Guillotine Bench Press': 'JIECaET8nt4',
    'Battling Ropes': 'ZvYYQsRMzTY',
    'Bench Press - Powerlifting': 'esQi683XR44',
    'Bent-Arm Barbell Pullover': 'ezRNDsGBTm4',
    'Bent Over Two-Dumbbell Row With Palms In': '--gDUDFKx6Q',
    'Bradford/Rocky Presses': 'gD6XoIXGmDI',
    'Cable Hip Adduction': '5Mkus4JdXDE',
    'Cable Rear Delt Fly': 'ywMSCem375A',
    'Calf-Machine Shoulder Shrug': '8Qla9t5I8rc',
    'Calf Press On The Leg Press Machine': 'PYZY00hI43w',
    'Carioca Quick Step': 'R3__Q_SulyM',
    "Child's Pose": 'kH12QrSGedM',
    'Clean from Blocks': 'T4EAdzwVEg4',
    'Close-Grip Barbell Bench Press': 'vEUyEOVn3yM',
    'Deficit Deadlift': 'CpWsUsqBtN8',
    'Depth Jump Leap': 'GeN0S3XCZnM',
    'Dip Machine': 'pMarNxAvHPc',
    'Dips - Triceps Version': 'WNMqN2O2MSs',
    'Dumbbell Alternate Bicep Curl': 'sAq_ocpRh_I',
    'Dumbbell Lunges': 'D7KaRcUTQeE',
    'Dumbbell One-Arm Shoulder Press': '4mzFocnr5mU',
    'Dumbbell One-Arm Triceps Extension': '2jl4M0Dnq4c',
    'Dumbbell Prone Incline Curl': 'OK6vpxXZ2pk',
    'Dumbbell Rear Lunge': 'sjlsISvHyZs',
    'Dumbbell Scaption': 'XOAIGRH90RY',
    'Elbow Circles': 'm9Grt4tCtvo',
    'Frog Hops': 'C54LoE13DUo',
    'Front Box Jump': 'hxldG9FX4j4',
    'Good Morning': '5Xj6XUa77qc',
    'Handstand Push-Ups': 'h0HjqYRlXYg',
    'Hug Knees To Chest': 'LugNxxfIdvo',
    'Incline Cable Chest Press': 'UJL1YgWL6Rg',
    'Incline Cable Flye': 'lzxCuqCTAjU',
    'Incline Push-Up Medium': 'cfns5VDVVvk',
    'Iron Crosses (stretch)': '5-BuRpLixls',
    'Jackknife Sit-Up': 'GEZ8NLbtc8Q',
    'Jerk Dip Squat': 'NYIgTh-XyYQ',
    'Kettlebell Hang Clean': 'lliRf_d6MDc',
    'Kettlebell Overhead Triceps Extension': 'qS5q6FgddTI',
    'Kettlebell Seesaw Press': '7Pnein1QoCk',
    'Kettlebell Turkish Get-Up (Lunge style)': '0bWRPC49-KI',
    'Knee Circles': 'urrVyUcNdkY',
    'Kneeling Cable Crunch With Alternating Oblique Twists': 'Bgpt62VKuGg',
    'Kneeling Hip Flexor': '6o-GpPIGR5w',
    'Lateral Raise - With Bands': 'gfEyrmxbCbw',
    'Latissimus Dorsi-SMR': 'I_76a2fVWc8',
    'Leverage Decline Chest Press': '_DsWm45BCqg',
    'Leverage Incline Chest Press': 'ig0NyNlSce4',
    'Lunge Pass Through': 'Vfx9-YwMkQ4',
    'Lying Dumbbell Tricep Extension': 'MO_03opCc0g',
    'Lying Supine Dumbbell Curl': 'okwUqL1kbEA',
    'Lying Triceps Press': '4re6CJ0XNF8',
    'Machine Bench Press': 'n8TOta_pfr4',
    'Machine Bicep Curl': 'QElooWsIgSs',
    'Machine Shoulder (Military) Press': '3R14MnZbcpw',
    'On Your Side Quad Stretch': 'uRRwljV-Nlk',
    'One-Arm Flat Bench Dumbbell Flye': '7LnGW4ik3hU',
    'One-Arm Kettlebell Clean': 'MYpz7OykS7I',
    'One-Arm Kettlebell Jerk': 'N6Rvg3EH8mM',
    'One-Arm Kettlebell Push Press': 'W9NlTHkK1iU',
    'One-Arm Kettlebell Row': 'bZ4h1Bqw-to',
    'One Arm Chin-Up': 'GbjQVfqJmX4',
    'One Arm Dumbbell Bench Press': '0L0VmmbjKCM',
    'One Arm Floor Press': 'KaJEdw3m2ec',
    'One Knee To Chest': 'Yd9wY25koVk',
    'Parallel Bar Dip': '2IUoEAzjZqY',
    'Platform Hamstring Slides': 'Wu9HVz64Sus',
    'Plyo Push-up': 'GR0ZL7f7u18',
    'Posterior Tibialis Stretch': 'qF4-KHLpH70',
    'Power Clean from Blocks': 'D0QwEQLbAYs',
    'Power Snatch': '1Tnl799bCqw',
    'Power Snatch from Blocks': 'yN1ouEOGpag',
    'Pull Through': 'DbSF7ipBh5Y',
    'Push-Up Wide': 'rr6eFNNDQdU',
    'Push-Ups With Feet On An Exercise Ball': 'mef57OKETPw',
    'Rack Delivery': 'dqPvGYaVnhA',
    'Reverse Band Power Squat': '2M_96-qIGC4',
    'Reverse Barbell Preacher Curls': 'DmYxZnU0ad4',
    'Reverse Machine Flyes': 'WCvRMULhUVU',
    'Rope Crunch': '_GUFTy1oBZY',
    'Scissor Kick': 'bUJnyVsa3Ak',
    'Seated Barbell Twist': 'snmLbyoLDLY',
    'Seated Dumbbell Palms-Up Wrist Curl': 'yio7CGPjQ-8',
    'Seated Dumbbell Press': 'rO_iEImwHyo',
    'Seated Good Mornings': 'XKXmApXuVUw',
    'Seated Head Harness Neck Resistance': 'VLdIkr2Gfdc',
    'Seated Leg Tucks': 'd_up4yEZhFI',
    'Seated Palm-Up Barbell Wrist Curl': 'qMtmHwaCmYI',
    'Seated Palms-Down Barbell Wrist Curl': 'FW7URAaC-vE',
    'Shoulder Press - With Bands': 'tQ40C0WD6OY',
    'Side Neck Stretch': '54y0JAT46vE',
    'Single-Arm Cable Crossover': 'xXy-q7enfxk',
    'Single-Arm Push-Up': 'JiHkxqbhNuw',
    'Single-Leg Lateral Hop': 'CMkuOg3Krtg',
    'Single-Leg Leg Extension': 'I1F58vIjbvc',
    'Smith Machine Overhead Shoulder Press': 'aKWQrB8afy0',
    'Smith Single-Leg Split Squat': 'adHTwUipN1o',
    'Snatch from Blocks': 'hWLOXxFDz9o',
    'Spider Crawl': 'FYc8dUkW9h8',
    'Split Snatch': 'vapEied94fU',
    'Band Squat': 'Eaqr79zvqIw',
    'Standing Barbell Press Behind Neck': 'I-Z3K0OqU5w',
    'Standing Biceps Cable Curl': 'NFzTWp2qpiE',
    'Standing Bradford Press': 'gD6XoIXGmDI',
    'Standing Dumbbell Press': 'e_f5oodNEcI',
    'Standing Dumbbell Reverse Curl': 'EoYWMB856cA',
    'Standing Dumbbell Triceps Extension': '-Vyt2QdsR7E',
    'Standing Gastrocnemius Calf Stretch': 'LntxVU3jpgo',
    'Standing Hip Flexors': 'ljCDEb_MIto',
    'Standing Leg Curl': 'Z053-kKjesQ',
    'Standing One-Arm Dumbbell Triceps Extension': '2jl4M0Dnq4c',
    'Standing Palms-Up Barbell Behind The Back Wrist Curl': 'sVLVLcsfWSo',
    'Standing Rope Crunch': 'wBzU6_YJPEU',
    'Standing Soleus And Achilles Stretch': 'Zmc36LtB7f8',
    'Standing Toe Touches': 'Xvr5N_Xf6QM',
    'Supine Chest Throw': 'ZlrvmNflFJw',
    'Thigh Adductor': 'GmRSV_n2E_0',
    'Trap Bar Deadlift': 'PWJU5grrh4Y',
    'Triceps Overhead Extension with Rope': 'mRozZKkGIfg',
    'Triceps Pushdown - Rope Attachment': 'kiuVA0gs3EI',
    'Upright Row - With Bands': 'VhpnXlphu88',
    'Weighted Crunches': '1YSxi0qv3wg',
    'Weighted Pull Ups': 'HuuyDNGrCI8',
    'Wide-Grip Pulldown Behind The Neck': 'I8FXgUKsPg0',
    'Wrist Rotations with Straight Bar': 'KGt1nihNfxc',
    'Paused Bench Press': 'K4BIkKGKy9k',
    'Paused Squat': 'ndkmWT9V9tc',
    'Landmine Row': '9hSQVBHLOX0',
    'Frog Pump': 'MQ62r2V7Lw8',
    'Kettlebell Goblet Squat': 'JO7D6GJ98wY',
    'Kettlebell Halo': 'YGZWa5be1hk',
    'Skater Hop': 'Jx2KXGbQkYM',
    'Kettlebell Snatch': 'AR6E01ABoHk',
    'Turkish Get-up': '0bWRPC49-KI',
    'Anti-Gravity Press': 'HXbetYIM-AY',
    'Around The Worlds': 'w_Pplr0hI1s',
    'Atlas Stones': 'go0WMsBSN6w',
    'Band Good Morning': 'fJA39ZOVaEQ',
    'Barbell Incline Shoulder Raise': 'zdALvgA0VCk',
    'Bent Press': 'cmVXzpLROGw',
    'Double Kettlebell Push Press': 'W9NlTHkK1iU',
    'Drag Curl': 'K1baXRg-OG8',
    'Frankenstein Squat': 'lqiax7HvENM',
    'Front Squats With Two Kettlebells': '3nA2ERmAyP0',
    'JM Press': 'hOCW9cE-GJg',
    "Landmine 180's": 'YC7poHGaVFE',
    'One-Arm Kettlebell Floor Press': '4ULa6AJcjr8',
    'One-Arm Kettlebell Split Snatch': 'lnhUi8nbFug',
    'One-Arm Kettlebell Swings': '5i_xp1vtkc4',
    'Otis-Up': 'BhtnaHGJa8w',
    'Prone Manual Hamstring': 'rYLpvcDWVt4',
    'Seated Band Hamstring Curl': 'M_dUNslNjBU',
    'Single-Arm Linear Jammer': 'XkvwvOje1DM',
    'Cable Kickback': 'Rmi70NbBv24',
    'Chair Dip': 'c3ZGl4pAwZ4',
    'V-up': 'GEZ8NLbtc8Q',
    'Outdoor Cycling': 'PiVcDIRF3V4',
    'Floor Press': 'vAFw7EPL4eM',
    'Front Two-Dumbbell Raise': 'CH9JzDStL3U',
    'Palms-Up Dumbbell Wrist Curl Over A Bench': '7ac_qmBjkFI',
    'Seated Flat Bench Leg Pull-In': 'd_up4yEZhFI',
    'Split Squat with Dumbbells': 'SkNsa3eBwLA',
    'Leg Extension': 'yR_LqZYSIgM',
    'Upright Cable Row': 'FfyheD6NZvU',
    'Single-Arm Dumbbell Press': '4mzFocnr5mU',
    'Dumbbell Triceps Extension': '2jl4M0Dnq4c',
    'Cable Reverse Fly': 'ywMSCem375A',
    'Bear Plank': 'XqH46t5TD98',
    'Pike Push-up': 'Tq1nYz7U5os',
    'Knee Push-up': 'ybdJn-OwSww',
    'Scapular Pull-up': '-ZIpSoTRsuE',
    'Prone T Raise': 'Yv6sUKOwOY8',
    'Prone Y Raise': 'Yv6sUKOwOY8',
    'High Plank': 'u6ZelKyUM6g',
    'Belt Squat': 'c6AtfEDcOyk',
    'Cossack Squat': 'gfod3jiMgl4',
    'Hip Airplane': 'zNGpdD6ig4U',
    'Landmine Press': 'gH7PDepHNck',
    'Dumbbell Preacher Curl': 'U77nfbV43uo',
    'Barbell Preacher Curl': 'Gydpcouclx8',
    'Single-Arm Cable Shoulder Press': 'aX8Hgk2zkQ0',
    'Seated Hamstring Stretch': 'wr_8aak4Wbc',
    'Treadmill Run': 'K6I24WgiiPw',
    'Ski Erg': '2hyGyZsPoC4',
    'Battle Rope': 'pQb2xIGioyQ',
    'Suitcase Carry': '3RKKnZhhelE',
    'Swimming': '6_vXycbD2TM',
    'Ball Leg Curl': 'XkESHgkTdFw',
    'Board Press': 'L9eF1acahSs',
    'External Rotation with Band': '_UvmPNGtlPM',
    'Hammer Grip Incline DB Bench Press': 'DnV3R4vp3K0',
    'Incline Dumbbell Bench With Palms Facing In': 'DnV3R4vp3K0',
    'Kettlebell Dead Clean': 'MYpz7OykS7I',
    'Kettlebell Pistol Squat': 'n7Fh6vGaJ7Y',
    'Kneeling Squat': 'LMEGUcIqXUU',
    'Side Bridge': 'XeN4pEZZJNI',
    'Side Leg Raises': 'olid32fu7LY',
    'Sled Push': '9XRRXaUpnLk',
    'Step Aerobics': 'qNAeuOs866Y',
    'Barbell Wrist Curl': 'qMtmHwaCmYI',
    'Sprawl': 'F1kVWDpH6co',
}


def main():
    read = lambda path: json.loads(path.read_text(encoding='utf-8'))
    initial = read(PRISMA / 'sources/primary-trainer-choices-20261106.json')
    selected = {name: video_id for name, video_id in initial.items() if name not in EXCLUDED}
    selected.update(ADDITIONAL)
    resumed_path = PRISMA / 'sources/resumed-trainer-decisions-20261106.json'
    resumed = read(resumed_path)['selected'] if resumed_path.exists() else {}
    for name, decision in resumed.items():
        assert decision['reason'] and decision['youtubeVideoId']
        selected[name] = decision['youtubeVideoId']
    annotated_path = PRISMA / 'sources/reviewed-annotated-trainer-tutorials-20261106.json'
    annotated = read(annotated_path)['selected'] if annotated_path.exists() else {}
    for name, row in annotated.items():
        assert row['reviewType'] == 'visual_preview_setup_and_instruction_cues' and row['previewFrames'] >= 4
        assert row['language'] == 'en' and row['contactSheet'] and row['reason']
        selected[name] = row['youtubeVideoId']
    catalogue = {row['name']: row for row in read(PRISMA / 'exerciseCatalogue.json')}
    cache_path = PRISMA / 'sources/trainer-tutorial-candidate-metadata.json'
    cache = read(cache_path)
    remaining_path = PRISMA / 'sources/remaining-trainer-candidate-metadata.json'
    if remaining_path.exists():
        for video_id, row in read(remaining_path).items():
            if video_id not in cache and 'captionLanguages' in row:
                cache[video_id] = row
    missing = sorted({video_id for video_id in selected.values() if video_id not in cache})

    def fetch(video_id):
        try:
            return video_id, metadata(video_id)
        except Exception:
            return video_id, {'youtubeVideoId': video_id, 'error': 'primary_metadata_unavailable'}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        cache.update(pool.map(fetch, missing))
    cache_path.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    accepted, withheld = {}, []
    for name, video_id in selected.items():
        row = cache[video_id]
        if row.get('playabilityStatus') != 'OK' or not row.get('embeddable') or not row.get('oembedAvailable'):
            withheld.append({'exercise': name, 'id': video_id, 'reason': 'Primary playable embed metadata unavailable'})
            continue
        visual = annotated.get(name)
        if not visual and not any(str(language).startswith('en') for language in row.get('captionLanguages', [])):
            withheld.append({'exercise': name, 'id': video_id, 'reason': 'English narration evidence not established; do not count a silent demo as a tutorial'})
            continue
        if not 10 <= row['durationSeconds'] <= 7200:
            withheld.append({'exercise': name, 'id': video_id, 'reason': 'Duration outside reviewed tutorial bounds'})
            continue
        if visual:
            assert visual['equipment'] == catalogue[name]['equipment']
            row['instructionFormat'] = visual['instructionFormat']
            row['languageEvidence'] = 'English on-screen instruction cues inspected in primary storyboard previews'
        accepted[name] = {'youtubeVideoId': video_id, 'equipment': catalogue[name]['equipment'],
                          'reviewType': 'primary_publisher_and_canonical_setup_review',
                          'instructionFormat': visual['instructionFormat'] if visual else 'trainer_instruction_with_english_captions',
                          'reason': visual['reason'] if visual else resumed[name]['reason'] if name in resumed else 'Published trainer/physio instructional reference; title and available description checked against canonical setup/equipment. English speech indicated by primary English captions; actual title, publisher, duration, playable embed and oEmbed verified. No rehosting or claim of physical-device playback.'}
    cache_path.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    rejected = [{'exercise': name, 'youtubeVideoId': initial[name], 'reason': reason} for name, reason in EXCLUDED.items()]
    report = {'reviewedAt': datetime.now(timezone.utc).isoformat(), 'constraint': 'Existing trainer-led tutorials only; no generated walkthroughs or bare movement-demo substitutions.', 'selected': accepted, 'rejectedCandidates': rejected, 'withheld': withheld}
    path = PRISMA / 'sources/trainer-tutorial-review-20261106.json'
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'selected': len(accepted), 'withheld': len(withheld), 'excluded': len(EXCLUDED), 'primaryChecks': len(missing)}))


if __name__ == '__main__':
    main()
