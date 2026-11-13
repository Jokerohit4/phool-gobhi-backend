# hasaneyldrm dataset integration

The complete 1,324-record dataset is retained at
`services/health-service/prisma/sources/hasaneyldrm-exercises-dataset.json`.

- Repository: https://github.com/hasaneyldrm/exercises-dataset
- Pinned revision: `7455efae41b330c265e7cd4b78dfa848e7ce5ebd`
- SHA-256: `656634224b8977b99a6d765470ee123260d4979715eaa4e7c0b7c8bb0d79f93d`
- All 2,648 referenced media paths exist in the pinned Git tree.
- Sixteen representative media URLs were fetched successfully; sampled GIFs are 180x180.
- Five existing Cloudinary GIFs were also checked and returned HTTP 200.

All instruction text, translations, targets, supporting muscles, original names,
categories, equipment and media references are preserved in the source snapshot.
Code/data and instructions are MIT-licensed. Media is separately licensed by Gym
Visual; the user confirmed an existing license covering app use in this conversation.
The upstream LICENSE and NOTICE are retained in `prisma/sources/`. Media retains
its copyright credit and native 180x180 maximum display dimensions.

## Applied content

375 compatible mappings are integrated in `prisma/exerciseSupplements.json`.
The resolver supplies the GIF and thumbnail, all ten instruction languages,
additional secondary muscles when the catalogue list is empty, and original
source metadata. Existing valid demos, coach content, exercise IDs and nonempty
muscle lists are preserved. Existing English free-source instructions remain
preferred; Hindi requests use this dataset's Hindi steps. The response identifies
the actual instruction language and separates text attribution from image credit.
The app shows those labels. Active workouts request and cache each language separately.

The matcher preserves equipment and movement qualifiers. It accepts existing
media references, exact names, explicit aliases and equivalent word order/spelling.
Explicit variant decisions and exclusions are retained in
`prisma/sources/hasaneyldrm-reviewed-mappings.json`. No source-only exercise names
were added to the catalogue in this import.

| Gap | Before | After |
| --- | ---: | ---: |
| Demo GIF | 939 | 721 |
| Any photo | 124 | 117 |
| Source instructions | 232 | 123 |
| Hindi source instructions | 1,103 | 728 |
| Secondary muscles | 365 | 240 |
| No GIF/photo/tutorial | 121 | 114 |

Tutorials remain missing for 1,083 exercises. Difficulty, force and movement
mechanic are not provided by this dataset; their gaps remain 227, 257 and 314.
Secondary muscles can intentionally be empty. This import does not fabricate
absent data or claim complete coverage. Counts are prepared local data, not
an audit of the currently deployed database.

[Integrated mappings](hasaneyldrm/integrated.csv) and
[exercises without a new accepted mapping](hasaneyldrm/unresolved-after-integration.csv)
reflect the applied supplement. Candidate, ambiguous and unmatched files from
the assessment command are preliminary proposals, not final integration decisions.
[Live verification receipt](hasaneyldrm/live-media-verification.json).
[All updated missing-field lists](README.md).

## Rebuild and release

From the backend root:

```powershell
node services/health-service/scripts/assessHasanExerciseDataset.mjs
node services/health-service/scripts/buildHasanExerciseSupplements.mjs
node services/health-service/scripts/reportExerciseDataGaps.mjs
```

The supplement builder verifies the retained source checksum before rebuilding.
Matching and API tests cover source-backed generated fields, language fallback,
existing-media preservation, ownership and equipment boundaries, empty source
instructions, and rejected variants. UI tests cover language labels, photo
fallback, attribution and native media dimensions.

Deploy the backend with the generated JSON files and release the customer-app
changes. The prior catalogue expansion still needs its additive Prisma migration
for new exercise rows. This supplement adds no schema columns and changes no
existing exercise IDs. No live database changes or deployments were performed.
