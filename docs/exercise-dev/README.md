# Dev exercise media — 6 November 2026

All **1,103 public catalogue exercises have a stored GIF and photo on dev**.
No exercise was hidden or deleted. Existing IDs, workout history, custom
exercises and curated assets were preserved. Production was not changed.

## GIF coverage

| Kind | Exercises |
| --- | ---: |
| Continuous motion GIF | 503 |
| Labelled source-photo pose sequence | 545 |
| Single-pose hold reference | 9 |
| Original schematic pose sequence | 46 |
| Total | 1,103 |

The user approved labelled start/end photo GIFs. Source ordering is labelled
“Reference pose” rather than assuming every upstream photo is a start or finish.
Static holds are explicitly labelled. The final 46 exercises use original SVG
schematics with pose cues; these are illustrations, not filmed motion or trainer
certification. Reference GIFs are not counted as instructional tutorials.
Actual motion takes precedence whenever a matching licensed asset is available.

References comprise 504 public-domain photo sequences, five public-domain holds,
30 Workout Guide CC BY-SA 4.0 sequences, 15 RepDB references (11 sequences and
four holds), and 46 app-owned schematics. Per-asset source links, author credits,
license terms and hashes are retained in `prisma/exercisePoseGifs.json`.
RepDB free-tier assets are used within the app with credit; its dataset is not
offered as a standalone download. CC BY-SA derivatives retain that license.

## Separate content coverage

| Field | Filled | Missing |
| --- | ---: | ---: |
| Demo GIF | 1,103 | 0 |
| Photo | 1,103 | 0 |
| English tutorial reference | 816 | 287 |
| Source/app guide | 1,103 | 0 |
| Hindi source guide | 401 | 702 |

GIF completion does not mean every content field is complete. All 66 starter
exercises have English tutorial references. Eleven direct MP4 demonstrations
are separate from tutorials. See the [field lists](../exercise-data-gaps/README.md)
and [remaining content work](../exercise-content-production/README.md).

This update adds 630 exercise tutorial references using existing publisher
footage: 489 with primary English-caption evidence and 139 filmed demonstrations
with visually reviewed English on-screen instruction steps, and two with locally
verified existing English coaching audio. The 816 exercise
mappings use 735 unique videos. No generated walkthroughs were produced and no
publisher footage was rehosted. Exact movement/equipment review rejected wrong
variants even when titles matched. Initial primary YouTube checks received HTTP
429; verification subsequently resumed successfully in small batches. Unverified
references remain excluded. The remaining 287 tutorials are unfinished.
All 308 original catalogue exercises now have a tutorial reference. Some guides
teach a reviewed support, grip or load-position variation; these differences
are recorded explicitly in `resumed-trainer-decisions-20261106.json` rather than
claiming identical footage for every variant. Later-phase preview checks resolved
the full toe-supported Body-Up and double-kettlebell jerk before selection.

All 72 missing English guides were filled: 28 licensed RepDB profiles and 44
original app guides. Eight incompatible guides were corrected, retaining
the superseded-source provenance. These are source/app guides, not approved coach
content. Existing coach content, translations and private exercises are preserved.
The 80 instruction profiles retain attribution and language. Towel Row's pinned
English and Hindi source text omitted the fixed anchor shown in its licensed
media; both requests now receive a correctly labelled original English guide.
Band hip adduction now teaches inward movement; lying dumbbell pronation and
supination teach forearm rotation instead of shoulder rotation. Corrections are
pinned to known source URLs. Other sources and translations are preserved. Whitespace-only
upstream steps are removed from runtime responses without altering raw snapshots.

When a requested-language tutorial is absent, the API returns the existing
English tutorial with its actual language and explicit fallback metadata. The
updated app labels the card English even when Hindi is selected. Genuine
requested-language videos take precedence; Hindi guide coverage remains separate.

## Evidence and rollout

- [Database backfill](apply.json): 1,103 rows, zero stored or effective missing
  GIF/photo fields. Public rows only; transactional identity-preservation check.
- [API verification](verify.json): all 1,103 detail responses and the full picker,
  including media, reference kind/provenance and exact tutorial metadata.
- [Asset availability](gif-availability.json): all 1,079 distinct GIF URLs used by
  1,103 exercises returned successful responses with GIF content types.
- [Deployment](deployment.json) records the tested revision, environment hash,
  service account and dev promotion. [Live smoke check](live-smoke.json) records
  the main dev URL. Runtime environment and secret bindings were preserved.
  Revision `health-service-dev-00196-luc` serves 100% of dev traffic; previous
  revision `health-service-dev-00194-fij` is retained for rollback.
- 57 distinct focused backend test cases passed across the focused runs,
  including complete source-guide coverage, tutorial review evidence, language
  fallback, GIF/photo coverage and custom-exercise isolation. The latest focused
  instruction/API/provenance subset passed all 17 cases. Fourteen focused
  Flutter tests passed, including actual tutorial language labels.
  Changed-file Flutter analysis passed. The earlier full backend suite had one
  unrelated `reportDetectedDate.test.js` localization failure.
- The updated dev Android APK built successfully. Package
  `in.phoolgobi.customer.dev`, version 1.0.0/code 5. No adb device was connected,
  so this build has not been installed. [Build evidence](app-build-20261106.json).
  The prior 5 November APK was installed on CPH2471 with app data preserved;
  [prior install evidence](app-install.json) applies to that earlier build.
- Two read-only Windows native video resolver probes found playable muxed
  streams. [Probe evidence](tutorial-stream-probe.json) does not establish
  physical Android playback of every video. [Verification limit](tutorial-verification-limits.json)
  records the primary publisher rate limit.

The initial dev catalogue had 308 exercises; 795 were added without deploying
unrelated migrations. Complete source snapshots retain 876 free-exercise-db,
1,324 hasaneyldrm and 930 wger records. Exact movement/equipment mappings control
what reaches users. Availability checks do not establish movement quality or
certified coaching; contact sheets and implementation review are retained in
`reference-review/` and the original SVG review manifest.

Run the dev-only operator from `services/health-service`:

```powershell
python scripts/exercise-dev.py audit
python scripts/exercise-dev.py verify
```

The scripts capture dev credentials in memory without writing them to reports.
The deployment script initially assigns no traffic; promote only after the
tagged revision passes verification. The previous revision is recorded for
rollback. All work here targets dev.
