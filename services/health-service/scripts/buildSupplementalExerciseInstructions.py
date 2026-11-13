"""Build exact English instruction fallbacks; never mark them coach-approved.

RepDB text is used inside the application under its free-tier license. The
remaining guidance is original app copy, identified separately from that source.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRISMA = ROOT / 'prisma'
REPDB = {
    'Air Bike': 'air-bike', 'Bear Plank': 'bear-plank-hold', 'Boat Hold': 'boat-pose',
    'Cable Reverse Fly': 'cable-reverse-fly', 'Chest-Supported Machine Row': 'chest-supported-machine-row',
    'Cossack Squat': 'cossack-squat', 'Cycling': 'cycling', 'Outdoor Cycling': 'cycling',
    'Deep Squat Hold': 'deep-squat-hold', 'Downward Dog': 'downward-dog',
    'Dumbbell Hip Thrust': 'dumbbell-hip-thrust', 'Dumbbell Sumo Squat': 'db-sumo-squat',
    'Hanging Knee Raise': 'hanging-knee-raise', 'Kettlebell Clean and Press': 'double-kettlebell-clean-and-press',
    'Kettlebell Reverse Lunge': 'kettlebell-reverse-lunge', 'Kettlebell Strict Press': 'one-arm-kettlebell-shoulder-press',
    'Nordic Hamstring Curl': 'nordic-hamstring-curl', 'One-Arm Kettlebell Swings': 'one-arm-kettlebell-swing',
    'Paused Bench Press': 'paused-bench-press', 'Paused Squat': 'pause-squat', 'Push Press': 'push-press',
    'Renegade Row': 'renegade-row', 'Running': 'running', 'Single-Leg Press': 'single-leg-press',
    'Single-Leg Squat to Bench': 'single-leg-box-squat', 'Standing Quad Stretch': 'standing-quad-stretch',
    'T-Bar Row': 't-bar-row', 'Wall Sit': 'wall-sit',
}
ORIGINAL = {
    'Aerobic Dance': [
        'Clear a level space and stand with your knees soft and your feet about hip-width apart.',
        'Begin with easy side steps, letting your arms swing naturally as you warm up.',
        'Combine comfortable steps, gentle knee lifts and arm movements in a rhythm you can sustain.',
        'Land softly, keep your knees aligned with your feet, and reduce the step size if you lose control.',
        'Gradually return to easy steps and slow your breathing to finish.',
    ],
    'Assisted Pistol Squat': [
        'Stand beside a fixed support that can safely take your weight and hold it for balance.',
        'Balance on one foot and extend the other leg in front of you.',
        'Bend the standing knee and sit your hips back and down, using the support only as much as needed.',
        'Keep your standing heel grounded and your knee following the direction of your toes; lower only as far as you can control.',
        'Press through the standing foot and use the support to return upright. Complete the repetitions, then change legs.',
    ],
    'Bayesian Cable Curl': [
        'Attach a single handle to a low cable pulley and select a light load.',
        'Face away from the stack in a stable split stance, holding the handle with your arm slightly behind your torso.',
        'Keep your upper arm still and curl the handle by bending your elbow without rolling the shoulder forward.',
        'Lower slowly to a comfortable elbow extension while keeping your ribs stacked over your pelvis.',
        'Finish the repetitions, return the weight stack gently, and repeat with the other arm.',
    ],
    'Belt Squat': [
        'Set the belt-squat machine stops and platform for your height, attach the belt securely around your hips and choose a manageable load.',
        'Stand with your feet about shoulder-width apart and hold the support handles lightly for balance.',
        'Release the machine catch as directed by its controls and bend your hips and knees to squat down under control.',
        'Keep your whole foot planted, your knees tracking with your toes and your torso comfortably upright.',
        'Push through your feet to stand, then engage the catch before unloading or removing the belt.',
    ],
    'Brisk Walking': [
        'Choose a clear, level route and start walking at an easy pace.',
        'Stand tall, relax your shoulders and let your bent arms swing naturally.',
        'Increase to a purposeful pace with quick, comfortable steps rather than reaching far ahead with your feet.',
        'Keep a pace at which you can still speak in sentences and adjust it to the terrain.',
        'Slow to an easy walk for the last few minutes.',
    ],
    'Butt Kick': [
        'Stand tall with feet hip-width apart and your arms relaxed by your sides.',
        'Jog gently in place and bend one knee to bring that heel toward your buttock.',
        'Place that foot down softly and alternate legs, keeping the knees pointing down rather than driving them forward.',
        'Keep your trunk steady and use a comfortable rhythm; the heel does not have to touch your buttock.',
        'Reduce to a march before stopping.',
    ],
    'Crab Walk': [
        'Sit on the floor with knees bent, feet flat and hands planted behind your hips in a comfortable wrist position.',
        'Press through your hands and feet to lift your hips clear of the floor.',
        'Take small steps with a hand and the opposite foot, then alternate to travel forward or backward.',
        'Keep your hips lifted without forcing an arch in the lower back, and move only as far as your shoulders and wrists allow.',
        'Stop moving and lower your hips to the floor under control.',
    ],
    'Dumbbell Clean and Press': [
        'Stand with feet hip-width apart and a dumbbell in each hand; keep the space overhead clear.',
        'Hinge at the hips with soft knees and hold the dumbbells close to your legs.',
        'Extend your hips and knees to bring the dumbbells upward, then guide your elbows underneath to catch them at your shoulders without striking your wrists.',
        'Set your balance, brace your trunk and press the dumbbells overhead without leaning backward.',
        'Lower to your shoulders and then to the starting position with control before beginning the next repetition.',
    ],
    'Dumbbell Dead Bug': [
        'Lie on your back and hold a light dumbbell securely with both hands over your chest.',
        'Lift your hips and knees to about ninety degrees and keep your ribs down and lower back gently supported by the floor.',
        'Keep the dumbbell steady while slowly extending one leg away from you, stopping before your back arches.',
        'Bring the leg back, then extend the other leg while continuing to breathe.',
        'Place both feet down and lower the dumbbell safely to finish.',
    ],
    'Dumbbell Devil Press': [
        'Place two stable, non-rolling dumbbells on the floor about shoulder-width apart and stand behind them.',
        'Grip the handles, step or jump back into a plank and lower your chest toward the floor with control.',
        'Press back up and bring your feet forward outside the dumbbells to a stable hip-hinge position.',
        'Drive through your legs and hips, keeping the weights close as you guide them overhead; finish balanced without leaning backward.',
        'Lower the dumbbells under control to your shoulders and then to the floor before repeating.',
    ],
    'Dumbbell Lateral Lunge': [
        'Stand tall holding a dumbbell in each hand by your sides.',
        'Take a comfortable step to one side, bend that knee and push your hips backward while keeping the other leg relatively straight.',
        'Keep the stepping foot flat and its knee aligned with its toes; let the dumbbells hang without rounding your back.',
        'Push through the stepping foot to return to the starting stance.',
        'Repeat to the other side, using a depth you can control.',
    ],
    'Dumbbell Squeeze Press': [
        'Lie on a flat bench with your feet planted and hold two dumbbells above your chest with palms facing each other.',
        'Bring the dumbbells together and maintain gentle inward pressure throughout the repetition.',
        'Bend your elbows to lower the weights toward your mid-chest, keeping your forearms controlled and shoulders stable.',
        'Press upward while continuing to squeeze the dumbbells together, without bouncing them off your chest.',
        'After the final repetition, lower the weights safely and sit up with control.',
    ],
    'Fast Feet': [
        'Stand with feet about hip-width apart, knees slightly bent and your trunk upright.',
        'Begin taking short, quick alternating steps in place, lifting the feet only slightly off the floor.',
        'Keep the contacts light, your shoulders relaxed and your body centred over your feet.',
        'Use a rhythm you can maintain without stumbling or letting your knees collapse inward.',
        'Gradually slow the steps and return to standing.',
    ],
    'Frog Pump': [
        'Lie on your back, bring the soles of your feet together and let your knees open comfortably to the sides.',
        'Keep your feet close enough to your hips to stay comfortable and rest your arms on the floor.',
        'Brace your abdomen and squeeze your glutes to lift your hips without arching your lower back.',
        'Pause briefly, then lower your hips with control while keeping the soles together.',
        'Repeat within a comfortable hip range, then lower fully to finish.',
    ],
    'Hiking': [
        'Choose a route suited to your experience, check the footing and begin at an easy walking pace.',
        'Keep your body tall and use shorter, steady steps on climbs rather than leaning far forward from the waist.',
        'Place each foot deliberately on uneven ground and keep your knees soft when descending.',
        'Adjust your pace to the slope and conditions, and stop in a stable place when you need a rest.',
        'Finish with easy walking on level ground where possible.',
    ],
    'Hip Airplane': [
        'Stand beside a fixed support and hold it lightly for balance.',
        'Balance on one leg with a soft knee and hinge forward at the hip, extending the free leg behind you.',
        'Keep your trunk and free leg moving together as you gently rotate your pelvis open away from the standing leg.',
        'Rotate the pelvis back toward the floor without twisting the standing knee or collapsing its arch.',
        'Return upright under control and repeat on the other side.',
    ],
    'Jogging': [
        'Begin with several minutes of easy walking on a clear route.',
        'Move into a gentle jog using short, comfortable steps and relaxed arm swings.',
        'Keep your posture tall and let your feet land close to underneath your body rather than reaching forward.',
        'Maintain an easy pace you can sustain while speaking, and return to walking whenever needed.',
        'Slow to a walk for a few minutes before stopping.',
    ],
    'Kettlebell Romanian Deadlift': [
        'Stand with feet about hip-width apart, holding a kettlebell with both hands in front of your thighs.',
        'Soften your knees, brace your trunk and push your hips backward while keeping the bell close to your legs.',
        'Lower only until you feel hamstring tension and can still keep your back steady; the bell need not touch the floor.',
        'Press through your feet and bring your hips forward to stand without leaning backward at the top.',
        'Repeat with a controlled lowering phase, then set the bell down safely.',
    ],
    'Landmine Press': [
        'Secure one end of a barbell in a landmine attachment and kneel on one knee facing the free end.',
        'Hold the free end at the shoulder on the side of the kneeling leg and plant the other foot firmly in front.',
        'Brace your abdomen and squeeze the glute on the kneeling side to keep your trunk upright.',
        'Press the bar forward and upward along its arc without leaning or rotating, then lower it to your shoulder with control.',
        'Complete the repetitions and change sides; support the bar safely when finishing.',
    ],
    'Lateral Lunge': [
        'Stand with feet hip-width apart and hands held comfortably in front of your chest.',
        'Step to one side and sit your hips back as you bend the stepping knee.',
        'Keep the stepping foot flat, the opposite leg relatively straight and your chest lifted.',
        'Push through the stepping foot to return upright without twisting the knee.',
        'Alternate sides using a comfortable step width and depth.',
    ],
    'Leaning Lateral Raise': [
        'Hold a fixed support with one hand and a light dumbbell in the other.',
        'Keep your feet planted and lean your body slightly away from the support, maintaining a straight, braced trunk.',
        'With a soft elbow, raise the dumbbell out to the side to about shoulder height or a lower comfortable position.',
        'Keep your shoulder away from your ear and lower the weight slowly without swinging.',
        'Return upright before changing sides.',
    ],
    'Low-Impact Skater': [
        'Stand with feet hip-width apart, knees soft and your trunk slightly inclined forward.',
        'Step sideways onto one foot, then lightly tap the opposite foot behind and across it.',
        'Push gently from the supporting foot and step to the other side, again tapping the trailing foot behind.',
        'Keep one foot in contact with the floor at all times and let your arms counterbalance the steps.',
        'Slow the side steps before returning to standing.',
    ],
    'Machine Hip Thrust': [
        'Adjust the hip-thrust machine back support and foot platform, then secure its padded belt or lap restraint across your hips.',
        'Plant your feet so your shins are close to vertical at the top of the movement, and release the catch using the machine controls.',
        'Brace your trunk and drive through your whole feet to extend your hips.',
        'Stop when your shoulders, hips and knees form a comfortable line; avoid arching your lower back.',
        'Lower under control, then engage the catch before undoing the restraint and leaving the machine.',
    ],
    'Machine Low Row': [
        'Adjust the seat and any chest pad so the low-row handles are reachable with your feet firmly supported.',
        'Hold the handles and sit tall with your arms extended and shoulders relaxed.',
        'Pull the handles toward your lower ribs by driving your elbows back, keeping your trunk steady.',
        'Pause without shrugging, then let your arms extend slowly without letting the weight stack crash.',
        'Finish the repetitions and return the handles safely.',
    ],
    'March in Place': [
        'Stand tall with feet about hip-width apart and use a fixed support for balance if needed.',
        'Lift one knee to a comfortable height while keeping your trunk upright.',
        'Place that foot down gently and lift the other knee, continuing to alternate.',
        'Swing your arms naturally and keep a steady rhythm without leaning backward.',
        'Lower the knee height and slow to standing to finish.',
    ],
    'Medicine Ball Russian Twist': [
        'Sit on the floor holding a light medicine ball near your chest, with knees bent and feet planted.',
        'Lean back slightly from your hips while keeping your chest lifted and your back controlled.',
        'Rotate your ribcage and carry the ball toward one hip without reaching or pulling with your arms alone.',
        'Return through the centre and rotate to the other side, keeping your knees relatively still.',
        'Keep both feet down for stability and return upright before setting the ball aside.',
    ],
    'Prone T Raise': [
        'Lie face down on a mat with your neck in a comfortable neutral position.',
        'Extend your arms out to the sides in a T shape with your thumbs pointing upward.',
        'Gently draw your shoulder blades back and lift your hands and arms a small distance off the floor.',
        'Keep your ribs and pelvis supported and avoid lifting your head or arching your lower back.',
        'Lower slowly and repeat without adding weight.',
    ],
    'Prone Y Raise': [
        'Lie face down on a mat with your neck relaxed and your legs resting on the floor.',
        'Reach your arms diagonally overhead to form a Y, with thumbs pointing upward.',
        'Keep your shoulders away from your ears and lift your arms gently without forcing the range.',
        'Keep your ribs and pelvis on the mat rather than extending your lower back.',
        'Lower the arms under control and repeat.',
    ],
    'Shadow Boxing': [
        'Stand in a comfortable staggered boxing stance with your knees soft, hands near your face and space clear around you.',
        'Begin with light, controlled straight punches into the air and return each hand to your guard.',
        'Rotate your hips and pivot your feet naturally with the punches rather than twisting a planted knee.',
        'Keep your wrists straight, do not snap your elbows into a hard lock, and add small balanced steps as comfortable.',
        'Reduce the pace and return to a relaxed stance to finish.',
    ],
    'Side Jackknife': [
        'Lie on one side with legs extended, your lower arm resting on the floor for balance and your top hand lightly beside your head.',
        'Brace your abdomen and lift your upper torso and legs toward each other in a small controlled side crunch.',
        'Keep your neck relaxed and avoid pulling your head with your hand or rolling your torso backward.',
        'Lower your torso and legs slowly to the starting position.',
        'Complete the repetitions and repeat on the other side.',
    ],
    'Single-Arm Cable Row': [
        'Set a cable pulley around lower-chest height, attach a single handle and stand facing it in a stable split stance.',
        'Hold the handle with your arm extended and brace your trunk so your hips and shoulders face forward.',
        'Pull the handle toward the same-side lower ribs by moving your elbow back without shrugging or rotating.',
        'Let the arm extend slowly while keeping your torso steady.',
        'Finish the repetitions, return the handle safely and switch arms.',
    ],
    'Single-Arm Cable Shoulder Press': [
        'Attach a single handle to a low pulley and take a stable split stance facing away from the stack.',
        'Bring the handle to shoulder height with your wrist above your elbow and the cable passing clear of your body.',
        'Brace your trunk and press the handle overhead without leaning back or letting your torso rotate.',
        'Lower slowly to shoulder height within a comfortable range.',
        'Return the handle safely after the repetitions and repeat with the other arm.',
    ],
    'Sprawl': [
        'Stand with feet about hip-width apart and knees soft, leaving clear space behind you.',
        'Bend your hips and knees and place your hands on the floor beneath your shoulders.',
        'Step or jump both feet backward into a straight-arm plank, keeping your abdomen braced rather than dropping your hips.',
        'Bring your feet back toward your hands and stand upright under control.',
        'Repeat at a manageable pace; this version finishes without a push-up or jump.',
    ],
    'Stability Ball Rollout': [
        'Kneel on a mat with a stability ball in front of you and place your forearms on the ball.',
        'Brace your abdomen and keep your hips, ribs and head aligned.',
        'Roll the ball slowly forward by opening at the shoulders and hips, keeping your knees supported.',
        'Stop before your lower back arches, then use your abdomen and shoulders to bring the ball back.',
        'Use a short controlled range and sit back before moving away from the ball.',
    ],
    'Standing Hamstring Stretch': [
        'Stand beside a fixed support and place one heel a short distance in front of you with the toes lifted.',
        'Keep that knee soft and bend the supporting knee slightly.',
        'Hinge forward from your hips with a long back until you feel a gentle stretch behind the extended thigh.',
        'Hold without bouncing or rounding down toward your toes, breathing steadily.',
        'Return upright and change legs.',
    ],
    'Standing Knee Drive': [
        'Stand tall with feet hip-width apart and keep a fixed support nearby if needed.',
        'Brace your trunk and drive one knee upward to a comfortable height while balancing on the other leg.',
        'Keep your pelvis level and avoid leaning backward or pulling the knee with your hands.',
        'Lower the foot softly and alternate legs at a controlled rhythm.',
        'Slow the movement and return to standing to finish.',
    ],
    'Step Aerobics': [
        'Place a low, stable exercise step on a non-slip surface with clear space around it.',
        'Stand facing the step and place your whole lead foot on the platform.',
        'Step up with the other foot, then step back down one foot at a time while keeping your knees aligned with your toes.',
        'Alternate the leading leg and use a pace and step height that let you land softly without losing balance.',
        'Reduce the pace and finish with easy marching on the floor.',
    ],
    'Step-Back Lunge': [
        'Stand tall with feet about hip-width apart and hands held comfortably for balance.',
        'Step one foot backward, keeping the feet on separate tracks rather than a tightrope line.',
        'Bend both knees and lower the back knee toward the floor while keeping the front foot planted.',
        'Keep your front knee following your toes and push through the front foot to return upright.',
        'Alternate legs or finish the planned repetitions before switching sides.',
    ],
    'Step-up': [
        'Stand facing a low, stable bench or step and place one whole foot on its surface.',
        'Lean forward slightly from the hips and press through the raised foot to lift your body.',
        'Bring the trailing foot up lightly without jumping or pushing hard off the floor.',
        'Step down slowly, keeping the lead knee aligned with its toes and your pelvis level.',
        'Complete the repetitions and change the leading leg.',
    ],
    'Swimming': [
        'Use a supervised swimming area suitable for your ability and begin with easy movement in the water.',
        'Choose a stroke you already know and keep your head and trunk aligned rather than forcing your neck upward.',
        'Coordinate comfortable arm strokes, a gentle kick and regular breathing at a pace you can control.',
        'Take rests at the pool edge as needed and avoid holding your breath for long distances.',
        'Ease the pace and finish at a secure pool edge; this general entry does not teach a specific swimming stroke.',
    ],
    'Thoracic Rotation': [
        'Start on hands and knees with your hands under your shoulders and knees under your hips.',
        'Place one hand lightly behind your head without pulling on your neck.',
        'Rotate your upper back to bring that elbow gently toward the opposite supporting arm.',
        'Then rotate the upper chest open and lift the elbow toward the ceiling, keeping your hips relatively still.',
        'Return under control, complete the repetitions and change sides.',
    ],
    'Walking Lunge': [
        'Stand tall holding a dumbbell in each hand at your sides, with enough clear space to walk forward.',
        'Take a comfortable step forward and bend both knees to lower your body while keeping the front foot flat.',
        'Keep your trunk steady, your front knee following its toes and the rear knee clear of the floor.',
        'Push through the front foot and bring the rear leg forward into the next lunge.',
        'Continue alternating with controlled steps, then stand still before setting the dumbbells down.',
    ],
    'Wall Angel': [
        'Stand with your back near a wall, feet a short distance forward and knees soft.',
        'Keep your ribs down and bring your arms into a bent-elbow goalpost position as close to the wall as comfortable.',
        'Slide your arms upward slowly without forcing your wrists or elbows against the wall.',
        'Stop before your lower back arches or your shoulders shrug, then lower to the goalpost position.',
        'Repeat within your comfortable shoulder range.',
    ],
    'Yoga Flow': [
        'Start on hands and knees with hands under shoulders and knees under hips on a comfortable mat.',
        'Breathe in as you gently lift your chest and tip your pelvis forward without compressing your lower back.',
        'Breathe out as you round your upper back and gently tuck your pelvis, keeping the movement comfortable.',
        'Continue this slow cat-cow flow with your breathing rather than forcing your neck or spine.',
        'Return to a neutral back and rest; this catalogue entry uses a simple cat-cow flow, not a full yoga class.',
    ],
}
OVERRIDES = {
    'Dumbbell Lying Pronation': {
        'reason': 'Canonical photos and forearm target show supported forearm pronation; retained text incorrectly describes shoulder rotation. Correct the joint action while preserving the lying bench setup.',
        'reference': 'https://www.youtube.com/watch?v=cFN80sNHFTs',
        'replacementSourceUrl': 'https://github.com/yuhonas/free-exercise-db/blob/a859101d633a01c4a1a920d6a8ce41dabba0705f/exercises/Dumbbell_Lying_Pronation.json',
        'steps': [
            'Lie securely on a bench and support the working forearm on the bench, with the hand free beyond its edge.',
            'Hold a very light dumbbell securely and keep your elbow and upper arm still; use only a load you can control through forearm rotation.',
            'Rotate the forearm slowly toward a palm-down position without bending your wrist or rolling your shoulder.',
            'Stop within a comfortable range and rotate back slowly, keeping the forearm supported.',
            'Complete the repetitions, set the weight down safely and change arms.',
        ],
    },
    'Dumbbell Lying Supination': {
        'reason': 'Canonical photos and forearm target show supported forearm supination; retained text incorrectly describes shoulder rotation. Correct the joint action while preserving the lying bench setup.',
        'reference': 'https://www.youtube.com/watch?v=4Om83PMgZAg',
        'replacementSourceUrl': 'https://github.com/yuhonas/free-exercise-db/blob/a859101d633a01c4a1a920d6a8ce41dabba0705f/exercises/Dumbbell_Lying_Supination.json',
        'steps': [
            'Lie securely on your side on a bench and support the working forearm, leaving the hand free to rotate beyond the bench edge.',
            'Hold a very light dumbbell securely and keep your elbow and upper arm still; use only a load you can control through forearm rotation.',
            'Rotate the forearm slowly toward a palm-up position without bending your wrist or rolling your shoulder.',
            'Stop within a comfortable range and rotate back slowly, keeping the forearm supported.',
            'Complete the repetitions, set the weight down safely and change arms.',
        ],
    },
    'Band Hip Adductions': {
        'reason': 'Retained text describes outward hip abduction, but the exercise name, target muscles and inspected canonical photos show inward hip adduction with the band on the leg nearest the anchor.',
        'reference': 'https://www.youtube.com/watch?v=Vce3tIYpzhc',
        'replacementSourceUrl': 'https://github.com/yuhonas/free-exercise-db/blob/a859101d633a01c4a1a920d6a8ce41dabba0705f/exercises/Band_Hip_Adductions.json',
        'steps': [
            'Secure a resistance band to a fixed support near ankle height and stand side-on to the anchor, holding a stable support for balance if needed.',
            'Place the band around the ankle of the leg nearest the anchor and step away until there is light tension.',
            'Keep your torso steady and the working knee comfortably straight as you draw that leg inward across the front of the standing leg.',
            'Return slowly toward the anchor without letting the band pull your body sideways.',
            'Complete the repetitions, remove the band safely and turn around to work the other side.',
        ],
    },
    'Towel Row': {
        'reason': 'Licensed canonical media shows a standing lean-back row using a towel anchored to fixed rungs. Retained English and Hindi text omit the anchor and describe unsupported towel pulling.',
        'reference': 'https://res.cloudinary.com/dgbydysk2/image/upload/v1793560856/phool-gobhi/exercises/uTv34oq-thumb.jpg',
        'replacementSourceUrl': 'https://github.com/hasaneyldrm/exercises-dataset/blob/7455efae41b330c265e7cd4b78dfa848e7ce5ebd/data/exercises.json',
        'replaceSourceLanguages': ['en', 'hi'],
        'steps': [
            'Loop a strong towel around a fixed support that is designed to bear your body weight, around chest height, and check that the towel and support cannot slip.',
            'Hold both ends securely, place your feet in front of the support and lean back with your body in a straight line and arms extended.',
            'Bend your elbows to draw your chest toward the support, keeping your shoulders controlled and your body straight.',
            'Extend your arms slowly to lean back again without dropping your hips or jerking on the towel.',
            'Make the movement easier by standing more upright, and step back to a stable standing position before releasing the towel.',
        ],
    },
    'Cable External Rotation': {
        'reason': 'Retained text placed the arm straight in front; the named side-elbow cable rotation and reviewed footage use a bent elbow beside the ribs.',
        'reference': 'https://www.youtube.com/watch?v=Qnp0VOXMpXk',
        'steps': [
            'Set a cable pulley around elbow height and stand side-on to it, holding the handle in the hand farther from the stack.',
            'Bend that elbow to about ninety degrees and keep your upper arm gently beside your ribs.',
            'Rotate your forearm away from your body without lifting the elbow or turning your trunk.',
            'Use a light load and a comfortable shoulder range, then return slowly.',
            'Finish the repetitions, return the handle safely and change sides.',
        ],
    },
    'Single-Arm Triceps Pushdown': {
        'reason': 'Retained generic text specified a straight bar at chest height rather than the high-pulley single-handle setup of the named exercise.',
        'reference': 'https://www.youtube.com/watch?v=FSD-tbnEX2k',
        'steps': [
            'Attach a single handle to a high cable pulley and stand facing the stack in a stable stance.',
            'Take the handle in one hand and bring your upper arm beside your ribs, with the elbow bent.',
            'Keep your upper arm still and straighten the elbow to press the handle down without leaning on it.',
            'Allow the elbow to bend slowly to return the handle, keeping your wrist comfortable and trunk steady.',
            'Complete the repetitions, return the handle safely and change arms.',
        ],
    },
    'Close-Grip Dumbbell Press': {
        'reason': 'Retained instructions describe a perpendicular-bench pullover rather than a close-grip chest press.',
        'reference': 'https://www.youtube.com/watch?v=axxSCgMwrzM',
        'steps': [
            'Lie lengthways on a flat bench with your feet planted and support a manageable dumbbell securely above your chest with both hands.',
            'Keep your hands close together, wrists steady and elbows pointing comfortably toward your sides.',
            'Bend your elbows to lower the dumbbell toward your mid-chest without lowering it behind your head.',
            'Press back up under control, keeping your shoulders supported and avoiding a bounce off your chest.',
            'Finish the repetitions and lower the weight safely before sitting up.',
        ],
    },
    'Neck Press': {
        'reason': 'Retained guillotine-style bench instructions told users to contact the neck with the bar; that contact instruction is removed. This is a bench-press variant, not a neck/overhead press.',
        'reference': 'https://www.youtube.com/watch?v=JIECaET8nt4',
        'steps': [
            'Use a flat bench inside a rack with safety stops set to prevent the bar reaching your neck, and use a spotter for the lift.',
            'Take a comfortable overhand grip, plant your feet and keep your upper back supported on the bench.',
            'Lower a light bar toward the upper chest only within a range you can control; never rest or press the bar onto your neck.',
            'Keep your wrists supported over the elbows and press the bar upward without forcing shoulder range or bouncing.',
            'Rack the bar securely after the set; stop the movement if you cannot maintain clearance and a comfortable shoulder position.',
        ],
    },
}


def main():
    read = lambda file: json.loads((PRISMA / file).read_text(encoding='utf-8'))
    catalogue = {row['name']: row for row in read('exerciseCatalogue.json')}
    database = {row['id']: row for row in read('sources/repdb.json')['exercises']}
    provenance = read('sources/repdb-provenance.json')
    assert hashlib.sha256((PRISMA / 'sources/repdb.json').read_bytes()).hexdigest() == provenance['hashes']['exercises.json']
    assert not set(REPDB) & set(ORIGINAL)
    result = {}
    for name in [*REPDB, *ORIGINAL]:
        assert name in catalogue, name
        sourced = name in REPDB
        steps = database[REPDB[name]]['instructions_en'] if sourced else ORIGINAL[name]
        assert len(steps) >= 3 and all(isinstance(step, str) and step.strip() for step in steps)
        result[name] = {
            'equipment': catalogue[name]['equipment'], 'language': 'en', 'instructions': steps,
            'provider': 'RepDB' if sourced else 'Phool Gobhi',
            'sourceId': REPDB.get(name),
            'sourceUrl': f"https://github.com/RepDB/exercise-dataset/blob/{provenance['revision']}/exercises.json" if sourced else None,
            'attribution': 'Exercise data by RepDB (repdb.co) · https://repdb.co · free-tier in-app license' if sourced else 'Phool Gobhi · original English exercise guidance',
            'rights': 'repdb_free_in_app' if sourced else 'phool_gobhi_original',
            'licenseUrl': f"https://github.com/RepDB/exercise-dataset/blob/{provenance['revision']}/LICENSE-DATA.md" if sourced else None,
            'reviewType': 'implementation_content_check',
            'reviewNotes': 'Exact canonical name/equipment and setup checked; source/app fallback only, not approved coach instructions or trainer certification.',
        }
    for name, correction in OVERRIDES.items():
        assert name in catalogue and name not in result
        result[name] = {
            'equipment': catalogue[name]['equipment'], 'language': 'en',
            'instructions': correction['steps'], 'provider': 'Phool Gobhi', 'sourceId': None,
            'sourceUrl': correction['reference'], 'attribution': 'Phool Gobhi · original English exercise guidance',
            'rights': 'phool_gobhi_original', 'licenseUrl': None,
            'reviewType': 'implementation_content_check', 'reviewNotes': correction['reason'],
            'mode': 'replace_incompatible_source', 'replacementReason': correction['reason'],
            **{key: correction[key] for key in ['replacementSourceUrl', 'replaceSourceLanguages'] if key in correction},
        }
    output = PRISMA / 'exerciseInstructionFallbacks.json'
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'profiles': len(result), 'repdb': len(REPDB), 'original': len(ORIGINAL), 'correctedIncompatibleSource': len(OVERRIDES), 'output': str(output)}))


if __name__ == '__main__':
    main()
