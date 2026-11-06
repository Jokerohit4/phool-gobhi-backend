# Free Exercise DB import

Source: https://github.com/yuhonas/free-exercise-db

The 876-record JSON snapshot was copied from the existing backend-root
`exercises_repo.json`, the previously saved distribution. It includes the three
upstream kettlebell exercises without images. This is retained input; rerunning
the build requires neither that untracked root file nor a network connection.
The upstream README, schema, representative records, license, and commit history
were checked during implementation. A fresh full-file download at the pinned
revision confirmed that all 876 records and every field equal this snapshot.
`free-exercise-db-provenance.json` records the upstream SHA-256 and revision;
the retained JSON has different whitespace, so its byte hash differs.

Photos use the supplied JPG paths at revision
`a859101d633a01c4a1a920d6a8ce41dabba0705f`, which includes the kettlebell additions.
This pins the image URLs against later branch changes. The repo distributes
the dataset as public domain / Unlicense; its license is retained alongside this
file. These images do not inherit Gym Visual attribution from the older demos.

`catalogue-base.json` preserves the original 308 definitions.
From health-service, run `node scripts/importFreeExerciseDb.mjs` to regenerate:

- `prisma/exerciseCatalogue.json`: 1,103 definitions, 795 additions.
- `prisma/exerciseSources.json`: exact canonical source mappings.
- `prisma/sources/import-report.json`: every source record and its mapping.
- `prisma/migrations/20261104120000_free_exercise_db_catalogue/migration.sql`:
  additive global exercises, with existing names/IDs preserved.

Only explicit equivalences and punctuation/case matches are combined. Equipment
conflicts remain separate: Air Bike's source photos depict a bicycle crunch;
Goblet Squat's source photos use a kettlebell; Split Squats is a stretch; band-only
squats are separate from a barbell squat with bands. Null equipment defaults to
`other`, except four explicitly identified bodyweight movements. Bands, balls,
foam rollers and other unsupported equipment use the app's existing `other`
bucket. Stretching/static holds use duration; cardio uses duration/distance
except rope jumping and stair machines; remaining new movements use reps/load.
Existing logging and muscle metadata are preserved.

English source instructions are returned separately from approved coach content.
The app shows them only when approved steps are absent, with English and source
labels. They are not written into the coach-content approval table.

To regenerate the Flutter test contract after changes, copy the generated
catalogue to customer-app `test/fixtures/workout/exercise_catalogue.json`.
The older customer-app `tools/workout_catalogue/build_catalogue.py` predates this
import; its generated backend output must not replace this expanded catalogue.

## Additional reviewed references

`wger-*.json` retains 930 exercise records and the image, video and license API
responses. `wger-provenance.json` records their URLs and SHA-256 values.
`exercise-reference-mappings.json` documents 52 field-level mapping decisions,
including deliberate image/instruction exclusions. Rebuild their output with
`node scripts/buildExerciseReferenceData.mjs` from health-service.
Only individually attributed CC0/CC-BY/CC-BY-SA records are eligible; the current
three video imports are H.264 MP4 demonstrations, separately labelled from
tutorials. Preserve per-asset author, license and original source links.

The retained `luis-exercise-*` research files are not a media source for the app:
their README explicitly leaves the footage origin and permission uncertain.
See `docs/exercise-content-production/README.md` at the backend root for the
remaining content backlog and the reviewed package import workflow.


## Derived public-domain motion

`public-exercise-media-mappings.json` contains explicit reviewed DVIDS choices;
excluded variants are retained as exclusions. The provenance file records the
original page/video hashes, source URL and sampled frames. Cat-Cow uses an actual
10-second motion segment, not an animation between still photos. The rendered
GIF/MP4/JPG asset hashes, credit, rights and clip/crop are retained in
`prisma/derivedExerciseMedia.json` and the dev review evidence. The uploader
verifies public availability/MIME/size before writing that runtime manifest.
The DVIDS source credit includes the required non-endorsement notice.

`reviewed-tutorial-mappings.json` contains 816 exercise-to-video selections.
`reviewed-tutorial-metadata.json` retains 735 unique primary publisher metadata
responses with actual titles, durations, channels and verification timestamps.
Tutorials link to the original YouTube publisher; their footage is not rehosted.

The 6 November review added 630 exercise references: 489 with primary English
caption evidence and 139 recorded demonstrations with visually inspected English
on-screen instruction steps, plus two with locally verified existing English
coaching audio. Explicit selections, equipment decisions and
rejected variants are retained in `trainer-tutorial-review-20261106.json` and
`reviewed-annotated-trainer-tutorials-20261106.json`. Contact sheets are retained
under the dev report's `reference-review/` directory. Resumed selections and
rejections, including explicitly recorded minor setup variations, are retained
in `resumed-trainer-decisions-20261106.json`. Candidate/search metadata
is research only and must not be bulk-published. Primary verification resumed in
small batches after the earlier rate limit; 287 exercises still lack a reviewed
tutorial reference. The original 308 exercises are all covered.

`reviewed-audio-trainer-tutorials-20261106.json` records two explicit selections
whose English coaching was verified locally when captions were absent. Public
publisher audio and full machine transcripts stay in private temporary storage;
the repository retains hashes, language metrics, setup reviews and summaries.
`reviewTrainerAudio.py` collects research evidence only and never publishes a
reference. Its default duration limit is 120 seconds; an explicit
`--max-duration 600` supports longer instructional sources. Silent clips and
movement/grip mismatches remain excluded even when speech detection succeeds.

`prisma/exerciseInstructionFallbacks.json` contains 80 reviewed profiles: 28
licensed RepDB guides, 44 original English app guides for missing instructions,
and eight original corrections to incompatible source guides. Towel Row's
correction is pinned to the faulty source URL and covers its English/Hindi text,
returning correctly labelled English rather than claiming a Hindi translation.
Raw upstream
snapshots remain intact. Runtime guidance retains source links, attribution,
language and superseded-source metadata, and never replaces approved coach
content. RepDB instruction use retains its required in-app credit and license
link; retained source snapshots are not a standalone public dataset.

## Labelled pose references

The user approved pose GIFs for exercises without matching motion footage.
`prisma/exercisePoseGifs.json` retains source URLs, source/asset hashes, pose
count, type, attribution and rights for 600 references: 504 public-domain
free-exercise-db photo sequences, five static holds from that source, 30 Workout
Guide CC BY-SA 4.0 sequences, 15 RepDB free-tier references (11 sequences/four
holds), and 46 original schematic sequences. Holds and schematics are labelled
explicitly; none is represented as filmed motion or an instructional tutorial.

Workout Guide's pinned snapshot, asset license, attribution and reviewed
mapping decisions are retained in `workout-guide-*`. Derived files retain
CC BY-SA 4.0 with author/source links and modification notices.

RepDB's pinned snapshot, terms and reviewed decisions are retained in `repdb*`.
Only free-tier artwork is used deterministically within the app, with the
required “Exercise data by RepDB (repdb.co)” credit/link in the project README.
No premium samples or generative transformations were used. Its custom license
does not permit publishing the dataset as a standalone data product; do not
export the retained research snapshot as a public dataset or general data API.

`phool-gobhi-pose-art/` retains original SVG sources and implementation visual
review notes for 46 uncovered exercises. These schematics were authored with
code-native primitives from movement definitions, not traced source artwork.
The review is not trainer certification. Public GIF/JPG/SVG derivatives are
content-addressed in the dev exercise-assets bucket. Motion media always takes
precedence over pose references; private exercises never inherit these assets.
