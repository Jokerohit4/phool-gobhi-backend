# Exercise media on dev

The catalogue contains **1,103 exercises**, including **795 additions** from
free-exercise-db. The complete upstream snapshots are retained: 876 records from
free-exercise-db, 1,324 from hasaneyldrm and 930 from wger. Exact reviewed mappings
attach compatible assets; retaining a source record does not mean its movement
matches a catalogue exercise. All original exercise IDs and history are preserved.

Current coverage and live deployment evidence are in the
[dev rollout report](../../docs/exercise-dev/README.md). Separate missing-field
lists are in [the gap inventory](../../docs/exercise-data-gaps/README.md).
Every exercise now has a stored GIF, photo and nonempty English source/app
instruction fallback on dev. Tutorial coverage remains incomplete.

## Current prepared content

| Content | Present | Missing |
| --- | ---: | ---: |
| Demo GIF | 1,103 | 0 |
| Photo | 1,103 | 0 |
| English tutorial reference | 711 | 392 |
| Source/app instructions | 1,103 | 0 |
| Hindi source instructions | 402 | 701 |

All 66 starter-routine exercises have an English tutorial reference. Tutorial
metadata retains the actual publisher, title and duration. Six older references
were replaced for movement or attribution errors. Selection evidence is retained
in `prisma/sources/reviewed-tutorial-metadata.json` and the tutorial decisions.
Public tutorial references link to their publishers; footage is not rehosted.
Tutorials are currently English. A request without a matching translated tutorial
falls back to the actual English reference, preserving `languageCode: en` and
returning `formVideoFallbackLanguage: en`. The updated app labels each tutorial
card with its real language; genuine requested-language videos take precedence.

The new 525 exercise references use existing publisher footage: 387 have primary
English-caption evidence and 138 have visually inspected English on-screen
instruction steps with a filmed demonstrator. No narrated slideshow or other
generated tutorial was produced. The full 711 mappings use 644 distinct primary
videos. Public player/oEmbed metadata preserves real titles, authors, durations
and embedding availability. Visual setup/step review and explicit rejections
are retained in `prisma/sources/trainer-tutorial-review-20261106.json` and
`reviewed-annotated-trainer-tutorials-20261106.json`; contact sheets are in the
dev report. Public publisher footage is not rehosted.

Seventy-two instruction gaps were filled with 28 licensed RepDB profiles and
44 original English app guides. Four known incompatible English source passages
were replaced with original app guidance, retaining upstream snapshots and
superseded-source provenance. These remain source/app guidance, never approved
coach content. Existing translated guidance is preserved. Empty upstream step
strings are omitted from runtime output; the retained snapshots stay intact.

New primary YouTube verification received HTTP 429. Unverified/mismatched
references remain absent rather than being counted as completed tutorials.

GIFs comprise 503 motion demonstrations, 545 labelled photo-pose sequences,
nine static hold references and 46 original schematic pose sequences. The user
approved labelled pose GIFs; reference images do not imply continuous movement.
The schematic art is explicitly labelled and is not trainer-certified footage.
All 1,079 distinct GIF assets passed live HTTP/MIME checks. References retain
source and license credit; CC BY-SA derivatives keep their license, RepDB assets
are credited for app use, and original SVG art/review is retained in sources.
Reference GIFs support zoom and full attribution in the updated dev app.

The hasaneyldrm source supplies 488 reviewed mappings. Several deliberately use
media only because the accompanying instructions describe a different setup.
Its Gym Visual media uses the app license confirmed by the user and retains
attribution and native 180-pixel resolution. The 52 reference profiles use
eligible source licenses with field-specific credit; third-party branded uploads
without dependable provenance are excluded.

Eleven direct H.264 MP4 demonstrations are distinct from instructional tutorials.
The Cat-Cow GIF, JPG and MP4 are derived from individually marked public-domain
[DVIDS footage](https://www.dvidshub.net/video/753723/cat-camel), with source credit
and the publisher's required non-endorsement notice. Source hashes, inspected
frames, crop and clip boundaries are retained. The reviewed derivatives are hosted in
`phool-gobhi-exercise-media-dev`, a dedicated public exercise-assets bucket.

Three additional wger motion clips were converted from source MOV/HEVC into
GIF/JPG/H.264 with author Goulart credited. Their derivatives remain CC BY-SA 4.0;
source links, license links and a conversion notice accompany them. The new GIFs
cover Face Pull, Barbell Hip Thrust and Barbell Walking Lunge. DVIDS conversions
also fill Bodyweight Squat, Plank and Side Plank. Forty more licensed GIF mappings
were visually reviewed, including movements stored in the legacy `other` bucket.

## User experience

Exercise details and active workouts use an existing valid GIF first and fall
back to source photos if it is missing or fails. Source steps appear when approved
coach instructions are absent and retain their actual language and source label.
Hindi source text is preferred when present; English fallback remains labelled
English. A silent demonstration is not counted as a tutorial. Private exercises
never inherit public source content merely by matching a name.

The customer app includes the photo gallery, source guide and separate direct-demo
player. The dev Android APK has been built and installed on the connected phone with
existing app data retained. Full phone playback remains to be checked.

## Rebuild and checks

Run from `services/health-service`:

```powershell
node scripts/buildHasanExerciseSupplements.mjs
node scripts/buildExerciseReferenceData.mjs
python scripts/buildReviewedExerciseTutorials.py
node scripts/reportExerciseDataGaps.mjs
node scripts/buildExerciseContentPlan.mjs
node scripts/checkExerciseMediaAvailability.mjs
```

Source builds are offline except the explicitly named tutorial metadata and asset
availability checks. GIF checks use the exact resolved URLs and verify live HTTP
status and MIME type; movement review is recorded separately.

The additive catalogue migration is
`20261104120000_free_exercise_db_catalogue`. Dev used a scoped transactional
backfill rather than deploying unrelated pending migrations. The dev-only runner
captures credentials in memory, fills missing public fields and preserves IDs,
history, custom exercises and unrelated curated media. `prisma/seedVideos.js`
repairs only the six explicit obsolete references and is idempotent.

Remaining assets must match the equipment, movement and variant. A larger licensed
download or reviewed trainer recordings can fill gaps the retained repositories
do not cover. The [content import workflow](../../docs/exercise-content-production/README.md)
validates real hosted assets, attribution and review evidence before import.
Pending templates, still poses and guessed URLs do not count as completed GIFs.
Production services and databases have not been changed.
