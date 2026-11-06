<p align="center">
  <a href="https://kinetic.place">
    <img src="https://kinetic.place/images/kinetic-logo-animated.gif" alt="Kinetic.place" width="400" />
  </a>
</p>

# 🏋️‍♂️ Kinetic Exercises (JSON)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![NPM Version](https://img.shields.io/npm/v/@kinetic-place/exercises-json)](https://npmjs.com/package/@kinetic-place/exercises-json)

An open-source JSON dataset containing **908 structured fitness exercises**, with muscle group mappings, equipment requirements, and, for 814 of them, a **step-by-step guide**: setup, steps, form cues, common mistakes, programming notes, and alternatives. Available in English and Spanish.

---

## 📦 Installation

```bash
npm install @kinetic-place/exercises-json
```

Or download the `.json` files directly from the `en/` and `es/` folders.

## 📂 What's Included

```
exercises-json/
├── en/
│   ├── exercises.json       # 908 exercises (English)
│   ├── guides.json          # 814 exercise guides (English)
│   ├── muscle_groups.json   # 17 muscle groups
│   └── equipment.json       # 44 equipment types
└── es/
    └── …                    # the same files in Spanish
```

Each file is a **single flat JSON array** — no configuration, no parsing, just import and go. Guides are a separate file, so apps that only need the exercises don't bundle them.

## 🚀 Quick Start

### JavaScript / TypeScript

```typescript
import exercises from '@kinetic-place/exercises-json/en/exercises.json';

console.log(exercises.length); // 899

// Find all chest exercises
const chestExercises = exercises.filter((ex) =>
  ex.muscleGroups.some((mg) => mg.slug === 'chest' && mg.type === 'primary')
);

// Find dumbbell exercises for beginners
const beginnerDumbbell = exercises.filter(
  (ex) => ex.difficultyLevel === 'beginner' && ex.equipment.some((eq) => eq.name === 'Dumbbell')
);
```

### Python

```python
import json

with open('node_modules/@kinetic-place/exercises-json/en/exercises.json') as f:
    exercises = json.load(f)

# Group by category
from collections import Counter
categories = Counter(ex['category'] for ex in exercises)
print(categories)
# Counter({'strength': 742, 'stretching': 60, 'cardio': 38, ...})
```

### React Native / Mobile

```typescript
// Bundle directly — no API calls needed
const exercises = require('@kinetic-place/exercises-json/en/exercises.json');

// Use in your workout builder
const exercise = exercises.find((ex) => ex.name === 'Barbell Bench Press');
```

### Guides and alternatives

```typescript
import exercises from '@kinetic-place/exercises-json/en/exercises.json';
import guides from '@kinetic-place/exercises-json/en/guides.json';

const guideFor = new Map(guides.map((g) => [g.exerciseId, g]));
const squat = exercises.find((ex) => ex.slug === 'barbell-squat');
const guide = guideFor.get(squat.id);

guide.execution; // the steps, in order
guide.alternatives.map((a) => a.name); // ['Dumbbell Squat', 'Leg Press']
guide.easierVariations.map((a) => a.name); // ['Goblet Squat', 'Bodyweight Squat']
```

## 📖 Data Schema

Each exercise object has the following structure:

```json
{
  "id": "d586b5aa-c2f4-4cb5-8038-d10b03c3b763",
  "name": "Barbell Bench Press",
  "slug": "barbell-bench-press",
  "type": "reps",
  "difficultyLevel": "intermediate",
  "forceType": "push",
  "mechanics": "compound",
  "category": "strength",
  "instructions": [
    "Lie flat on a bench with your feet planted firmly on the floor...",
    "As you breathe in, slowly lower the bar to your mid-chest..."
  ],
  "muscleGroups": [
    { "id": "...", "slug": "chest", "name": "Chest", "type": "primary" },
    { "id": "...", "slug": "triceps", "name": "Triceps", "type": "primary" }
  ],
  "equipment": [
    {
      "id": "...",
      "name": "Barbell",
      "type": "weight",
      "usageType": "single",
      "family": "barbell",
      "numItems": null
    }
  ]
}
```

### Field Reference

| Field             | Type             | Description                                                                                                     |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`              | `string`         | UUID — stable across versions                                                                                   |
| `name`            | `string`         | Exercise name (localized)                                                                                       |
| `slug`            | `string`         | URL-safe identifier (e.g., `barbell-bench-press`), the same in every language                                   |
| `type`            | `string`         | Measurement type: `reps`, `time`, or `distance`                                                                 |
| `difficultyLevel` | `string \| null` | `beginner`, `intermediate`, or `expert`                                                                         |
| `forceType`       | `string \| null` | Primary force: `push`, `pull`, or `static`                                                                      |
| `mechanics`       | `string \| null` | Movement type: `compound` or `isolation`                                                                        |
| `category`        | `string \| null` | Exercise category (see values below)                                                                            |
| `instructions`    | `string[]`       | Step-by-step text from the original dataset. Kept for compatibility; prefer the guide's `setup` and `execution` |
| `muscleGroups`    | `MuscleGroup[]`  | Muscles targeted (see below)                                                                                    |
| `equipment`       | `Equipment[]`    | Required equipment (see below)                                                                                  |

### Categories

`strength` · `stretching` · `cardio` · `plyometrics` · `powerlifting` · `olympicWeightlifting` · `strongman`

### Difficulty Levels

`beginner` · `intermediate` · `expert`

### Muscle Group Object

| Field  | Type     | Description                                      |
| ------ | -------- | ------------------------------------------------ |
| `id`   | `string` | UUID                                             |
| `slug` | `string` | URL-safe identifier (e.g., `chest`, `biceps`)    |
| `name` | `string` | Display name (e.g., `Chest`, `Biceps`)           |
| `type` | `string` | Targeting: `primary`, `secondary`, or `tertiary` |

**17 muscle groups**: abdominals · abductors · adductors · biceps · calves · chest · forearms · glutes · hamstrings · lats · lower back · middle back · neck · quadriceps · shoulders · traps · triceps

### Equipment Object

| Field       | Type             | Description                                                                           |
| ----------- | ---------------- | ------------------------------------------------------------------------------------- |
| `id`        | `string`         | UUID                                                                                  |
| `name`      | `string`         | Equipment name (e.g., `Barbell`, `Dumbbell`)                                          |
| `type`      | `string`         | `weight` or `resistance`                                                              |
| `usageType` | `string \| null` | `single`, `double`, or `multiple`                                                     |
| `family`    | `string \| null` | Broad kind: `barbell`, `dumbbell`, `bench`, `rack`, `bands`, `balls`, `bodyweight`, … |
| `numItems`  | `number \| null` | Number of items needed (if applicable)                                                |

**44 equipment types** including: Barbell · Dumbbell · Cable · Machine · Body Only · Kettlebell · Bands · Bench · Squat Rack · Plyo Box · and more.

## 🧭 Exercise Guides

`guides.json` holds one guide per exercise, in the same order as `exercises.json`. **814 of the 908 exercises** have one, in English and Spanish. The other 94, mostly expert-level lifts, are waiting for review by a person.

```json
{
  "exerciseId": "8fa123b2-cc06-4c69-a5be-8129bc29c4c5",
  "summary": "The ab roller has you kneeling on the floor, holding a small wheel with handles, rolling it forward as far as you can control...",
  "whyItWorks": "As the wheel rolls forward, your body extends into a longer and longer lever...",
  "setup": [
    "Kneel on a mat or padded surface, holding the wheel with both hands directly beneath your shoulders.",
    "..."
  ],
  "execution": [
    "Slowly roll the wheel forward, extending your arms and body together as one unit.",
    "..."
  ],
  "formCues": ["Roll only as far as your hips stay level.", "..."],
  "breathing": "Exhale as you roll out, inhale as you pull back toward your knees.",
  "commonMistakes": [
    {
      "mistake": "The lower back sags toward the floor as the roll extends.",
      "correction": "Shorten the roll distance immediately..."
    }
  ],
  "programmingNotes": [
    "Start with 2 or 3 sets of 5 to 8 reps at a short, fully controlled range...",
    "..."
  ],
  "safetyNotes": ["..."],
  "faq": [
    {
      "question": "How far should I roll out with an ab wheel?",
      "answer": "Only as far as you can keep your hips level..."
    }
  ],
  "alternatives": [
    {
      "exerciseId": "e415dbf1-eb35-4d84-a126-bf4b4f3bb295",
      "name": "Plank",
      "reason": "Trains the same core bracing without any equipment at all, for a no-tools alternative."
    }
  ],
  "easierVariations": [
    { "exerciseId": "66e9349c-4c36-4b74-a5a6-4448af654e64", "name": "Dead Bug", "reason": "..." }
  ],
  "harderVariations": [
    { "exerciseId": "5f0bdce6-...", "name": "Barbell Ab Rollout", "reason": "..." }
  ]
}
```

| Field              | Type                        | Description                                                          |
| ------------------ | --------------------------- | -------------------------------------------------------------------- |
| `exerciseId`       | `string`                    | The exercise's `id` in `exercises.json`                              |
| `summary`          | `string`                    | What it is, what it trains, who it suits                             |
| `whyItWorks`       | `string`                    | The mechanics behind it                                              |
| `setup`            | `string[]`                  | Position and equipment before the first rep                          |
| `execution`        | `string[]`                  | The steps, in order                                                  |
| `formCues`         | `string[]`                  | Short cues to keep in mind during the set                            |
| `breathing`        | `string \| null`            | When to breathe in and out                                           |
| `commonMistakes`   | `{ mistake, correction }[]` | Mistakes specific to this exercise, each with its fix                |
| `programmingNotes` | `string[]`                  | Sets, reps, how often, and where it fits in a session                |
| `safetyNotes`      | `string[]`                  | Conservative cautions                                                |
| `faq`              | `{ question, answer }[]`    | Questions people search for about this exercise                      |
| `alternatives`     | `ExerciseLink[]`            | Different exercises for the same muscles, e.g. without the equipment |
| `easierVariations` | `ExerciseLink[]`            | Easier versions of the movement                                      |
| `harderVariations` | `ExerciseLink[]`            | Harder versions that build on it                                     |

An `ExerciseLink` is `{ exerciseId, name, reason }`: the linked exercise's `id` and name, and one sentence on why it fits.

Guides are written from each exercise's structured facts, not from the `instructions` text. They're general guidance, not medical advice.

## 🌐 Locales

| Language | Path        | Status                       |
| -------- | ----------- | ---------------------------- |
| English  | `en/*.json` | ✅ 908 exercises, 814 guides |
| Spanish  | `es/*.json` | ✅ 908 exercises, 814 guides |

## 🔌 Prefer an API?

If you'd rather fetch exercises on demand instead of bundling the JSON, use the free REST API:

```bash
# Search exercises by muscle group
curl "https://api.kinetic.place/v1/exercises?muscle=chest&limit=5"

# Full-text search
curl "https://api.kinetic.place/v1/exercises?q=bench+press"

# Combined filters
curl "https://api.kinetic.place/v1/exercises?muscle=biceps&equipment=dumbbell&level=beginner"

# An exercise's guide, in English or Spanish
curl "https://api.kinetic.place/v1/exercises/8fa123b2-cc06-4c69-a5be-8129bc29c4c5/guide?lang=es"
```

See [`@kinetic-place/exercises-api`](https://github.com/kinetic-place/exercises-api) for self-hosting, or use the free hosted instance at `https://api.kinetic.place`.

## Related Packages

| Package                                                                          | Description                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`@kinetic-place/exercises-db`](https://github.com/kinetic-place/exercises-db)   | Database-ready format with separate entity files |
| [`@kinetic-place/exercises-api`](https://github.com/kinetic-place/exercises-api) | Self-hostable REST API with search + filtering   |

## 🙏 Acknowledgments

A massive thank you to [wrkout/exercises.json](https://github.com/wrkout/exercises.json) for providing the foundational list of gym exercises that kickstarted this dataset!

## 🚀 Building a Fitness App?

This dataset is part of [**Kinetic.place**](https://kinetic.place) — the open platform for developers and fitness creators. Whether you're building a workout tracker, a coaching app, or creating fitness content, Kinetic provides the data, APIs, and tools to ship faster.

👉 **[kinetic.place](https://kinetic.place)** — Exercises, APIs, and content for fitness builders.

## License

MIT © [Kinetic.place](https://kinetic.place)
