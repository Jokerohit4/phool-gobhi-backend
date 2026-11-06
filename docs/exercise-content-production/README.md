# Closing the remaining exercise content gaps

The current catalogue has 1,103 exercises. Remaining gaps are **0 GIFs,
0 photos, 392 English tutorials, 0 source/app guides and 701 Hindi source guides**.
Counts overlap. All 66 starter exercises have English tutorial references.
The [field inventory](../exercise-data-gaps/README.md) lists each missing field;
the [dev rollout report](../exercise-dev/README.md) records live verification.
Every exercise has a GIF/photo on dev. GIFs include explicitly labelled pose,
hold and schematic references; these do not count as continuous motion footage
or instructional tutorials. The user approved labelled photo-pose GIFs.

This folder describes remaining content work, not a production deployment queue.
All work in this session targets dev.

## Remaining content order

| Batch | Exercises | Work |
| --- | ---: | --- |
| [P0](P0.csv) | 0 | Starter-routine exercises missing a visual or guide |
| [P1](P1.csv) | 0 | Other exercises missing a visual or guide |
| [P2](P2.csv) | 49 | Other starter exercises missing a requested deliverable |
| [P3](P3.csv) | 850 | Remaining tutorial, translation or metadata work |

[recording-plan.json](recording-plan.json) records the exact movement, equipment,
starter usage and deliverables for each exercise. Two hundred and four catalogue exercises
have none of the tracked actionable gaps. Actual runtime fallback also depends
on approved database content. March in Place now has a schematic GIF, photo,
English tutorial and original English source/app guide.

Only existing trainer-led/recorded instructional references are eligible under
the user's preference. Narrated slideshows are not a substitute. The remaining
392 tutorial gaps have no approved exact existing reference in the integrated
sources; new primary YouTube checks are currently rate-limited (HTTP 429).
The separate missing-tutorial list remains the source of truth. English fallback
keeps instruction text available; 701 genuine Hindi translations still need work.

## A complete content package

First match any larger Gym Visual download already covered by our app license
against the exact movement, equipment and variant. The supplied repository has
already been fully retained and matched where appropriate; it cannot fill every
catalogue entry. Additional licensed assets can reduce recording work, but a
silent GIF cannot replace an instructional tutorial.

For movements still uncovered, record a trainer session with clean repetitions
and a separate instructional segment covering setup, movement, breathing,
common mistakes and finishing safely. Export a clean H.264 MP4 demonstration,
derive its GIF and JPG thumbnail, and export the instructional MP4. Keep the
actual tutorial language and duration. Review English and Hindi setup/movement/
finish steps, difficulty, force, mechanic and supporting muscles against the
exact movement. `not_applicable` classifications require a reason. An empty
supporting-muscle list is valid only when explicitly reviewed with a reason;
it should not be populated merely to remove an empty field.

Upload the real files to our media host, then fill
[content-package.template.json](content-package.template.json). It deliberately
contains pending/null fields and cannot be imported as completed content.
Record a reviewer, timestamp, actual attribution, and an internal ownership or
license evidence reference. Internal reviewer/evidence fields are not sent to
users. A package currently supplies one actual tutorial language; produce and
review the corresponding language version before offering it in that language.

## Import and rebuild

Run from `services/health-service`:

```powershell
node scripts/buildExerciseReferenceData.mjs
node scripts/reportExerciseDataGaps.mjs
node scripts/buildExerciseContentPlan.mjs
node scripts/importExerciseContentBundles.mjs C:/content/reviewed-packages.json --check
node scripts/importExerciseContentBundles.mjs C:/content/reviewed-packages.json
node scripts/reportExerciseDataGaps.mjs
node scripts/buildExerciseContentPlan.mjs
```

The importer validates the entire package before writing and checks every hosted
asset for successful HTTP responses and correct media MIME types. It rejects
placeholder URLs, incompatible equipment, missing languages and incomplete
reviews. It atomically updates `prisma/ownedExerciseContent.json`, preserving
exercise IDs and workout history. `--check` makes no content changes. The API
applies approved packages to matching public exercises after deployment; no new
database columns are needed. Existing approved coach instructions retain their
normal priority. No owned packages have been submitted, uploaded or deployed.

## Reference decisions

The 42 reviewed profiles retain field-specific source links and license credits.
Wger includes individually licensed references; only eligible CC0/CC-BY/CC-BY-SA
records are used. Only three supplied videos were usable H.264 MP4; MOV/HEVC
files require a separately reviewed conversion before import. AI-flagged or
ambiguous images and misleading variant instructions were excluded. Paused
bench/squat receive only basic-movement photos, not instructions pretending to
teach the pause. See the mapping reasons in
`services/health-service/prisma/sources/exercise-reference-mappings.json`.

The researched `luisaraujoc/free-exercise-db-api` README explicitly leaves video
ownership uncertain. Its footage is not used. Source availability and labels
alone do not establish that an asset depicts the right movement.

This pass also reduced unreviewed supporting-muscle gaps from 240 to 228,
difficulty gaps from 227 to 210, force gaps from 257 to 240 and mechanic gaps
from 314 to 300. Primary muscles, app equipment, muscle group and logging type
are already present for every catalogue exercise. Missing classifications remain
unknown until sourced or reviewed; no synthetic values were inserted.

## Validation

The focused verification passed 100 Flutter tests and 26 backend tests. Flutter
analysis of the eight changed model/player/guide/screen/test files found no
issues. Checks cover direct MP4 routing, legacy YouTube compatibility, playback
failure cleanup, demo/tutorial labels, source attribution, language fallback,
private/equipment isolation and content-package validation. The pending package
template was rejected before any write. Reference builds verify retained wger
snapshot hashes, record counts and completed pagination.
