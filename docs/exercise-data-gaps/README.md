# Exercise data gaps

Inventory: **1,103 catalogue exercises**, using 876 retained free-exercise-db records, 1,324 retained hasaneyldrm records and 930 retained wger records.

These lists describe the source resolver output from local prepared data, not live user/database coverage. URL counts require valid HTTPS. The hasaneyldrm media paths were checked against the pinned repository tree; other assets and tutorial videos still require live checks. Consult the integration report for mapping decisions.

GIF coverage includes labelled photo-pose sequences and hold references approved by the user, plus original schematic pose sequences. These are distinct from continuous motion footage and instructional tutorials. See the [dev rollout](../exercise-dev/README.md) for the type breakdown and [GIF availability results](../exercise-dev/gif-availability.json) for live asset checks.

Approved coach instructions and curated database-only media cannot be counted from these files. Source instructions are an app fallback. English media-seed steps are separate candidate copy seeded as pending: their presence does not establish approval or that they appear to users.

Blank secondary muscles can be intentional. The app equipment bucket `other` counts as present, even when upstream equipment is null or unsupported. Missing retained source metadata includes both unmapped catalogue exercises and null fields in mapped records; each CSV states which.

Retained difficulty/force/mechanic/category are not dedicated UI fields yet. These lists measure the available source data for future use, not currently displayed labels.

An exercise can appear in multiple lists. Do not add the counts together.

[Master spreadsheet: every exercise and coverage flag](all-exercises.csv) · [Summary CSV](summary.csv) · [Summary JSON](summary.json)

## Content

| Missing data | Missing | Present | Separate list |
| --- | ---: | ---: | --- |
| No usable demo GIF URL | 0 | 1103 | [CSV](missing-demo-gif.csv) |
| No photo URL from either media seed or source | 0 | 1103 | [CSV](missing-photos.csv) |
| No source photo gallery | 5 | 1098 | [CSV](missing-source-photo-gallery.csv) |
| No tutorial video seed entry | 365 | 738 | [CSV](missing-tutorial-video.csv) |
| No licensed direct MP4 demonstration | 1092 | 11 | [CSV](missing-direct-demo-video.csv) |
| No tutorial entry or direct demonstration | 365 | 738 | [CSV](missing-watchable-video.csv) |
| No source fallback instructions | 0 | 1103 | [CSV](missing-source-instructions.csv) |
| No Hindi source fallback instructions | 701 | 402 | [CSV](missing-hindi-source-instructions.csv) |
| No instruction text in source or English media seed | 0 | 1103 | [CSV](missing-all-instruction-text.csv) |

## Combined gaps

| Missing data | Missing | Present | Separate list |
| --- | ---: | ---: | --- |
| Neither GIF nor photo | 0 | 1103 | [CSV](missing-both-gif-and-photos.csv) |
| No GIF, photo, direct demonstration or tutorial | 0 | 1103 | [CSV](missing-all-visual-media.csv) |
| No GIF/photo and no instruction text in source or seed | 0 | 1103 | [CSV](missing-visual-and-instructions.csv) |

## Catalogue fields

| Missing data | Missing | Present | Separate list |
| --- | ---: | ---: | --- |
| Empty primary muscles | 0 | 1103 | [CSV](missing-primary-muscles.csv) |
| Empty secondary muscles (can be intentional) | 178 | 925 | [CSV](missing-secondary-muscles.csv) |
| Empty supporting-muscle list without a recorded review | 178 | 925 | [CSV](unreviewed-secondary-muscles.csv) |
| Empty muscle group | 0 | 1103 | [CSV](missing-muscle-group.csv) |
| Empty app equipment | 0 | 1103 | [CSV](missing-equipment.csv) |
| Empty logging type | 0 | 1103 | [CSV](missing-logging-type.csv) |

## Retained source metadata (not exposed as dedicated UI fields)

| Missing data | Missing | Present | Separate list |
| --- | ---: | ---: | --- |
| Missing retained source difficulty | 206 | 897 | [CSV](missing-source-difficulty.csv) |
| Missing retained source force (push/pull/static) | 236 | 867 | [CSV](missing-source-force.csv) |
| Missing retained source mechanic (compound/isolation) | 297 | 806 | [CSV](missing-source-mechanic.csv) |
| Missing retained source original category | 66 | 1037 | [CSV](missing-source-category.csv) |
| Missing retained source original equipment | 128 | 975 | [CSV](missing-source-equipment.csv) |

## Refresh

From the backend root:

```powershell
node services/health-service/scripts/reportExerciseDataGaps.mjs
```
