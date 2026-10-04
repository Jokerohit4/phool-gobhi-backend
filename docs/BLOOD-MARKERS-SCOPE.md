# Blood-panel biomarkers: scoping the `BiometricMetric` gap

Status: **scope only — nothing implemented.** Written 2026-10-04 while fixing the
blended-score 500s (`1807f3c`, `37fd488`).

Every claim below was verified against `schema.prisma`, the migration history,
and the live dev database — not inferred.

---

## 1. The gap, precisely

`BIOLOGICAL_TARGETS` (`services/ledger/constants.js:20-45`) defines targets for
four blood markers. `BiometricMetric` (`prisma/schema.prisma:511-521`) contains
none of them.

```
BIOLOGICAL_TARGETS keys : hba1c, ldl, hdl, triglycerides
BiometricMetric members : weight, body_fat, resting_hr, sleep_minutes, steps, hrv, stress
intersection            : ∅
```

`computeBiologicalScore` (`scoreEngine.js:523-552`) sums `target.weight` only for
markers present in that map. With no rows ever matching, `totalWeightUsed` stays
`0` and it returns `null` (`scoreEngine.js:546-551`).

`computeBlendedHealthScore` (`scoreEngine.js:561-572`) weights
`weightBeh = 0.4`, `weightBio = 0.6`. With the biological half permanently
`null`, **the blended health score has only ever been the behavioural 40%.**

Live dev DB: `health."BiometricEntry"` holds 2 rows (`weight`, `body_fat`). The
7-member enum is confirmed by `pg_enum`.

## 2. Why adding to the enum is necessary but not sufficient

The HTTP write path does **not** read the Prisma enum. It reads a hand-written
object:

```
biometricService.js:12-20   METRIC_UNITS    { 7 keys }   canonical unit per metric
biometricService.js:25-33   METRIC_BOUNDS   { 7 keys }   sanity ranges
biometricController.js:4    const METRICS = Object.keys(biometricService.METRIC_UNITS)
```

`METRICS` is the allow-list that gates `POST /biometrics` (per-entry, line 32-34),
`GET /biometrics?metric=` (59-61) and `DELETE /biometrics/:metric/:localDate`
(84-86). `METRIC_BOUNDS` gates `validateMetricValue` (88-96).

So a new enum member that is missing from `METRIC_UNITS` is **accepted by the
database and rejected by the API** — or worse, invisible. Adding the enum alone
changes nothing user-facing.

> There is currently **no automated check that `METRIC_UNITS` ≡ `BiometricMetric`.**
> `test/schemaMigrationParity.test.js` keeps `LEDGER_ENUMS` (184-187) in sync for
> nine other enums but omits `BiometricMetric`, and `BiometricEntry` is absent from
> `LEDGER_MODELS` (111-125). That missing guard is the structural cause of this
> whole class of bug.

## 3. The lab-report OCR path is dead for every input

Separate from §1, and more urgent, because it is a user-visible feature that
cannot work at all.

`utils/ocrService.js:69-81` `METRIC_MAP` emits:

| emitted value | in `BiometricMetric`? |
|---|---|
| `hbA1c` | no (also wrong case — enum is lowercase snake) |
| `glucose` | no |
| `ldl` | no |
| `hsCRP` | no |
| `tsh` | no |
| `vitamin_d` | no |
| `vitamin_b12` | no |

`reportService.js:60` writes these to `reportExtraction.createMany({ metric: … })`.
`ReportExtraction.metric` is typed `BiometricMetric` (`schema.prisma:1864`) — a
**second** column on the same enum. Prisma throws, the `catch` at
`reportService.js:81-88` flips the report to `FAILED`, and rethrows 500.

Net effect: **every uploaded lab report fails processing, and
`verifyExtractionService` is unreachable** because no `ReportExtraction` row can
ever be created.

Also note `hdl` and `triglycerides` are **absent from `METRIC_MAP` entirely** —
there is no `'high density lipoprotein'` or `'triglyceride'` key.

Two further traps on the write-through path (`reportService.js:147-167`):
- it bypasses `validateUnit`, so `unit: 'mg/dL'` lands raw in `BiometricEntry.unit`,
  and `fhir/codeMaps.js:90-108` `UNIT_MAP` has no `mg/dL` → `conversionWarnings`
  on every ABHA export;
- `localDate` is stamped **today**, not the report date, so the day-grain unique
  `(userId, metric, localDate)` collapses repeat panels.

## 4. Change set

Ordered. Items 1-2 are mechanical; 3-4 are the ones that actually unblock users;
5-7 are the OCR path; 8-9 keep ABHA export honest.

| # | File | Change |
|---|---|---|
| 1 | `prisma/schema.prisma:511-521` | add `hba1c, ldl, hdl, triglycerides` (lowercase — must match `BIOLOGICAL_TARGETS` keys and survive the engine's `.toLowerCase()`) |
| 2 | new `prisma/migrations/<ts>_add_blood_markers/` | 4 × `ALTER TYPE "health"."BiometricMetric" ADD VALUE IF NOT EXISTS` |
| 3 | `services/biometricService.js:12-20` | `METRIC_UNITS`: `hba1c:'%'`, `ldl/hdl/triglycerides:'mg/dL'` — **this is the edit that unblocks the API** |
| 4 | `services/biometricService.js:25-33` | `METRIC_BOUNDS`: plausibility ranges only, e.g. hba1c [3,20], ldl/hdl [20,400], triglycerides [10,1000] |
| 5 | `utils/ocrService.js:69-81` | normalise `hbA1c`→`hba1c`; add `hdl`/`triglycerides`; **decide** on `glucose`, `hsCRP`, `tsh`, `vitamin_d`, `vitamin_b12` (add to enum, or drop from the map — today they are the sole reason every report fails) |
| 6 | `services/reportService.js:147-167` | reconcile `unit` through `validateUnit`; decide the `localDate` policy for historical panels |
| 7 | `services/ledger/constants.js:15` | decide whether to bump `RULES_VERSION` — its own header says bump when a value changes, and scores will shift once biology contributes |
| 8 | `services/fhir/codeMaps.js:72` | `BIOMETRIC_MAP` LOINC entries, else rows are **silently dropped** (`wellnessBundle.js:143-145`, which pushes a `no FHIR mapping` warning and omits the row): HbA1c 4548-4, LDL 13457-7, HDL 2085-9, triglycerides 2571-8 — *confirm against the LOINC release before shipping; ABHA export correctness depends on these being exact* |
| 9 | `services/fhir/codeMaps.js:90` | `UNIT_MAP`: add `mg/dL` (`%` already present). Verified absent today |
| 10 | `test/schemaMigrationParity.test.js` | add `BiometricMetric` to `LEDGER_ENUMS`, `BiometricEntry` to `LEDGER_MODELS`, and assert `METRIC_UNITS` ≡ enum (mirroring the existing `FOOD_LOG_SOURCES` check at 218-243) |

**Migration mechanics:** house style is hand-authored SQL with a leading
rationale comment and `IF NOT EXISTS` throughout; precedent for this exact
operation is `20260924000000_add_run_tracker/migration.sql:10`. That file carries
a warning that `ALTER TYPE … ADD VALUE` cannot run in the same transaction as a
statement using the new value. This migration is four `ALTER TYPE` statements and
nothing else, so a single-statement-per-transaction file sidesteps the problem.

## 5. Consent — a product decision, not a code change

Writes to `BiometricEntry` are already gated by `requireBiometricConsent`
(`routes/health.js:302-306`, write-only). But blood markers are a **new class of
data**, and the schema anticipates that:

- `HealthConsent.scopes` is `String[] @default(["logs"])`
  (`schema.prisma:32-51`), with the comment: *"a scope is added when the surface
  needing it ships, and the app only offers a toggle for a scope that can change
  something."*
- The per-scope policy-wording map already names `medical_records` as an example scope.

So the questions to settle before writing code:

1. **New scope for structured lab values?** `logs` does not cover blood markers.
   Per the schema's own rule, a scope is added when its surface ships — so either
   add e.g. `lab_results` now, or land the enum work behind `logs` and accept the
   mismatch.
2. **Document vs structured value.** `BiometricConsent` (schema.prisma:587) covers
   *body numbers a person types in* and is deliberately separate from the
   `HealthConsent` device-access grant. A lab PDF is a **document** →
   `medical_records` scope + the vault. Extracted numeric values are structured
   data → biometric path. An upload therefore touches **two** grants, and today
   nothing links them: granting the vault does **not** grant `BiometricConsent`
   for the extracted values.
3. **Clinical-significance framing.** These are the first markers on the platform
   that a user could reasonably act on clinically. That raises the bar on the
   `general_wellness` posture — worth an explicit decision before any of it is
   user-visible, not after.

## 6. DPDPA exposure that exists today, independent of this work

Found while scoping; **not caused by the enum work and not fixed by it.**

`health.HealthReport` (`schema.prisma:1834`) and `health.ReportExtraction`
(`:1860`) are absent from all three of:

- account erasure — `services/consentService.js` (verified: neither string appears
  anywhere in the file)
- data export — `services/exportService.js` (verified: neither string appears)
- erasure verification — `services/auth-service/scripts/verify-erasure-live.mjs:107,205`

The important nuance: **the vault is covered.** `medicalDocument` — the other
lab-report storage path — *is* erased (`consentService.js:160`) and its Cloudinary
objects are removed via `deleteUserObjects` (`:182`). So the platform has two
lab-report storage routes and only one is wired into DPDPA. An OCR-uploaded report
(`HealthReport` + every `ReportExtraction` row) is **neither exported on request
nor deleted on erasure**, and `HealthReport.cloudinaryUrl` retains a live
Cloudinary URL after account deletion.

`retentionService.test.js:83` asserts `biometricEntry` survives erasure, so the
stated intent is that the user's own record goes with the account. These tables
are simply not wired up.

This is worth fixing on its own timeline; it is a live compliance gap, and it sits
in the same code the enum work touches.

## 7. Recommendation

Do **not** land this as one change. Three reasons: item 5 is a decision about
which markers the product claims to support; §5 is a consent decision with legal
weight; and items 1-4 alone already deliver most of the user-visible value.

Suggested sequencing:

- **Phase 1** — items 1-4. Makes manual entry of the four markers work, and the
  biological 60% of the blended score comes alive. No consent change needed
  beyond confirming `logs` scope is acceptable, no OCR dependency.
- **Phase 2** — items 5-6. Unblocks lab-report upload, which is broken for every
  input today and is the more valuable feature.
- **Phase 3** — items 8-10. ABHA export fidelity plus the parity guard that stops
  this recurring.
- **Separate** — §6 DPDPA erasure/export gap.

The single highest-value item is **item 10**. The drift between a hand-written
allow-list and a Prisma enum, with nothing asserting they agree, is what produced
both bugs fixed today and will produce the next one.
