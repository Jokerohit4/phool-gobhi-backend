# ABHA + ABDM FHIR integration — design & implementation doc

**Status:** design only, no production code. Nothing here has been built.
**Date:** 2026-09-30 · **Scope:** `services/health-service` (+ one small booking-service event change in Stage 2) and the Flutter customer app
**Research access date for every URL below:** 2026-09-30

Legend used throughout:
- **VERIFIED** — read in a primary source (NHA/ABDM, NRCeS, PIB, IRDAI, MeitY, CDSCO, Apple, Google), URL given.
- **UNVERIFIED: …** — not confirmed; the text says what would need checking.
- **CODE** — verified by reading this repo, file cited.

---

## A. Executive summary (plain language)

**What we're building**
- A way for a Phool Gobhi user to **take their fitness and adherence record out of the app in India's official health-record format** (FHIR R4, the format ABDM uses).
- Later, an **optional link to the user's ABHA** (the 14-digit government health ID). Never at signup, never required.
- Later still, a **"share my adherence summary" button** that sends an insurer or employer a *score* — not raw health data — with the user's explicit, time-limited, revocable permission.

**What it costs**
- Stage 0 (the FHIR export): **engineering time only, ~1–2 weeks, zero government approval.**
- Stage 1 (ABHA link in the ABDM test environment): free sandbox access, ~3–6 weeks of engineering. Needs the company registered first (GSTIN at sandbox exit).
- Going live with ABHA in production: **paid functional testing + a paid security audit (WASA)**, plus moving health data to India-hosted storage. Fees are not published — get quotes.
- Becoming a full government-listed health-records app: **4–8 months**. Not recommended now.

**What a user gets**
- A download of their own record in the national standard — something they can hand to a doctor or another app.
- Optionally, their ABHA shown on their profile, so their Phool Gobhi record is anchored to a verified identity.
- Full control over any sharing: see exactly what goes out, for how long, to whom; stop it any time; see a receipt of every past share.

**What an insurer gets**
- A **derived adherence summary** ("attended 11 of 12 planned sessions this month, 9 verified by gym QR scan") with each number labelled by *how* it was proven.
- It is **not** raw steps, heart rate, food diaries or medical documents — and it never includes anything that came from Apple Health or Google Health Connect (their rules forbid it).
- Legal basis on the insurer side: IRDAI already lets insurers reward "preventive and wellness habits", including gym memberships and renewal discounts.

**Honest position**
- ABDM integration gives **credibility and a standard format**, not money (the government incentive pays ~₹2.50 a record and the current round ended today).
- The thing that actually makes the data "verified" is **our gym QR check-in**, not the government stack.

```
  What happened              How we package it           Who can receive it
  ─────────────              ─────────────────           ──────────────────
  workouts, check-ins   ──►  FHIR WellnessRecord   ──►   the user (download)        Stage 0-1
  weigh-ins, plan ticks      (national standard)
                                                   ──►   ABDM network              Stage 3+ (optional)
  daily adherence score ──►  Insurer-grade summary ──►   insurer / employer         Stage 2
                             (derived, no HK/HC data)    (user-approved, expiring)
```

---

## B. Research findings

### B.0 Premises in the brief that turned out wrong or outdated (read this first)

| Brief said | Reality | Status |
|---|---|---|
| UHI forbids a user app from preferring its own providers | That was a **proposal in NHA's Dec 2022 consultation paper**. No binding UHI network policy has been published. 2026 PIB lists "fair discoverability" only as a principle. | **OUTDATED** — VERIFIED that the paper existed (https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=1883652); content via secondary summary |
| UHI settlement = nodal accounts, collector-equals-settler | Also a **2022 proposal**. Live UHI (2026) is **pay-on-visit only**; UHI "do[es] not determine, collect, process… or refund any payment". | **OUTDATED** — UNVERIFIED primary: source is NHA onboarding doc v2.0 (June 2026) mirrored in an unverified GitHub org `nha-in` |
| UHI gateway pre-1.0, "upcoming" | Old repo says protocol 0.0.1 (stale, last push 2024-09). Current contract reportedly Gateway spec **v2.0.2**. | PARTLY OUTDATED — VERIFIED old repo https://github.com/NHA-ABDM/UHI; v2.0.2 UNVERIFIED |
| UHI launched 29 June 2026 | Correct. | **VERIFIED** https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2278987 |
| Gyms are not in the HFR taxonomy | Correct. No gym/fitness/yoga-studio facility type. **Physiotherapy Clinic/Hospital** exist. "Other (please specify)" exists but using it for a gym is a misrepresentation risk. | **VERIFIED** HFR SOP https://abdm.gov.in/strapicms/uploads/HFR_SOP_for_verifiers_2697480f8a_2_fc7c967615_4_51f1289d5c.pdf |
| "Prior-health-record-metrics" is likely our HI type | **No such HI type exists.** Ours is **WellnessRecord**. | **VERIFIED** (see B.3) |
| Fidelius needed for server→HIU push, not user export | Essentially right, with one nuance: it's needed for **any HIP/HRP→HIU transfer through ABDM**, including a *user-initiated* share from a PHR app. A user downloading their own file, or a direct B2B share outside ABDM, does not need it. | **VERIFIED** (see B.8) |
| DHIS ≈ ₹2.50/record, trivial | Correct — and **the current round (Corrigendum 7) was "effective April 2026 till September 2026"**, i.e. it ends today. | **VERIFIED** (see B.9) |

**Skipping UHI is still right — but for different reasons**, all current:
1. **ABDM Milestone 2 is a hard prerequisite** to join UHI ("Applications that have not completed M2 cannot be onboarded onto UHI services"). UNVERIFIED primary (same `nha-in` mirror); consistent with UHI requiring HPR/HFR-credentialed participants (VERIFIED, PIB 2278987).
2. **No fitness, wellness or physiotherapy service category is live or announced.** Live: in-person doctor consult (the only end-to-end bookable service), PM-JAY hospital search, blood bank, ambulance, Jan Aushadhi, (reportedly) NOTTO. Next phase per PIB: labs, vaccination, pharmacy. VERIFIED PIB 2278987.
3. **No online payment** on the network yet — nothing to integrate our wallet with.

### B.1 IG version to target — **v6.5.0** (VERIFIED)
- Published IG: **v6.5.0**, FHIR R4, "the current published version", generated 2025-05-08. https://nrces.in/ndhm/fhir/r4/index.html
- **v7.0.0 is a preview**: "Draft as of 2026-07-15", headed "Local Development build". https://www.nrces.in/preview/ndhm/fhir/r4/index.html
- What changes 6.5.0 → 7.0.0: **UNVERIFIED** — no changelog found. The WellnessRecord section list is the same in the 7.0.0 preview. 7.0.0 lists `CarePlan` among its profiles — **UNVERIFIED** whether that becomes a home for our PlanItem. Recheck before Stage 3.
- Validator the sandbox FAQ tells integrators to use: HAPI validator 6.2.1 with `-ig https://nrces.in/ndhm/fhir/r4` (FAQ Q37, VERIFIED https://sandboxcms.abdm.gov.in/uploads/FAQ_20_11_2025_808a25df64.pdf).

### B.2 ABHA creation (VERIFIED unless marked)
- **API version: V3 only.** V1/V2 migration deadline was **31 Jan 2025**; sandbox banner warns V1/2 credentials will be deactivated; sandbox exit rejects M1 built on V1/2. https://sandbox.abdm.gov.in/ (and `?doc=SandboxExit`)
- **Can an integrator create an ABHA for a user?** Yes — **after M1 certification**, via **Aadhaar OTP** (mandatory for private apps), optionally Aadhaar biometrics or Driving Licence. The **user performs the OTP**; the app **must not store the Aadhaar number** and must show NHA's consent text (with "government" removed for private entities). Endpoints `/v3/enrollment/request/otp` → `/v3/enrollment/enrol/byAadhaar`. M1 guide v1.4: https://sandboxcms.abdm.gov.in/uploads/ABDM_ABHA_V3_AP_Is_V1_31_07_2025_869ab8cda9.pdf
- **Driving-licence route** only yields an enrolment number; the user must then be verified at a participating health facility. `?doc=UsingDrivingLicense`
- **ABHA number:** 14 digits, one per person, strong KYC. Samples read `91-XXXX-XXXX-XXXX`. **UNVERIFIED** that every number starts with 91.
- **ABHA address** (a.k.a. PHR address): `username@abdm` in production, `@sbx` in sandbox. Can be **self-declared** (name, year of birth, gender, mobile/email) without KYC and linked to an ABHA number later. Rules: ≥4 chars, letters/digits/dot, can't start with a number. Up to 6 addresses per number; up to 6 numbers per mobile. `?doc=phr-framework`, `?doc=UsingMobileNumber`, FAQ Q12–13.
- **Mobile-only creates an ABHA address, not an ABHA number.**
- M1 feature list for a private app also makes **"Verify by scanning Health Facility QR"** and **"Download ABHA card"** mandatory. `?doc=Milestone_one`
- **No generic "Sign in with ABHA" (OAuth-style) product found** — UNVERIFIED. ABHA login is a PHR-app feature.

### B.3 Record linking and HI types (VERIFIED)
- ABDM is **federated**: records stay with the source; the NHA consent manager (HIE-CM) is "data blind" and holds only links and consents. `?doc=phr-framework`
- **8 HI types:** Prescription, DiagnosticReport, OPConsultation, DischargeSummary, ImmunizationRecord, HealthDocumentRecord, **WellnessRecord**, Invoice. (The M2 doc v2.8 still says "7" in places — docs are inconsistent.) `?doc=HealthRecordFormats`, FAQ Q2.
- **WellnessRecord** = a `Composition` (canonical `https://nrces.in/ndhm/fhir/r4/StructureDefinition/WellnessRecord`), IG 6.5.0. Required: `status`, `type`, `subject` (Patient), `date`, `author` (1..*, may be **Patient, Device, Organization**, Practitioner, RelatedPerson, PractitionerRole), `title`, `section` 1..*. https://nrces.in/ndhm/fhir/r4/StructureDefinition-WellnessRecord.html
  Sections: VitalSigns · BodyMeasurement · **PhysicalActivity** · GeneralAssessment · WomenHealth · **Lifestyle** (diet, sleep, smoking, alcohol) · OtherObservations (Observation | Condition) · DocumentReference.
- `ObservationPhysicalActivity`: `code` bound to `ndhm-physical-activity` with **Extensible** strength (so our own codes are allowed when no suitable code exists); `effective[x]` may be dateTime, **Period**, Timing or instant; value Quantity or string. https://nrces.in/ndhm/fhir/r4/StructureDefinition-ObservationPhysicalActivity.html
- How a *non-facility* app pushes a record: PHR apps "must allow users to scan and upload any records … output from IoT devices … fit-bit, smartwatches", linked by HIP-initiated linking, shared via the M2 data-flow APIs. `?doc=UploadingUserRecord`. **But** the linking APIs require an `X-HIP-ID` header (HFR-ID format) and the framework says "Only verified health facilities that are part of the Health Facility Registry can link health records". **UNVERIFIED — the single biggest open question: how a non-facility PHR app obtains a HIP ID for self-uploaded records.** Ask integration.support@nha.gov.in.

### B.4 Which of our models have a home — see §C. Summary, counted per model (42): **3 map cleanly** (BiometricEntry, WorkoutSession, ExerciseRecord), **6 partially or only via our own codes** (DailyActivityMetric, ScoreDaySnapshot, PlanItemCompletion, FoodLog, CyclePhaseEntry, MedicalDocument), **33 have no home** (HealthCondition deliberately).

### B.5 Consent artefact (VERIFIED, `?doc=UnderstandingConsents` + PHR V3 doc)
- Fields: `consentId`, `createdAt`, `patient.id`, `careContexts[]`, `purpose{text,code,refUri}`, `hip`, `consentManager`, `hiTypes[]`, `permission{accessMode:"VIEW", dateRange{from,to}, dataEraseAt, frequency{unit,value,repeats}}`, CM `signature`, status.
- **Purpose codes (only these six are accepted; others → `ABDM-9999`):** CAREMGT, BTG, PUBHLTH, **HPAYMT** ("payers conducting financial or contractual activities related to payment for provision of health care"), DSRCH, **PATRQT** (patient's own request).
- **None cleanly fits "insurer reward for adherence".** HPAYMT is about paying for care delivered. Get NHA + counsel to confirm before building an ABDM-routed insurer flow.
- Expiry: `dataEraseAt` = how long the HIU may keep data. Revocation: any time; HIU "must remove any copy". Consent is **per HIU (recipient) and time-bound**. Consent `dateRange` cannot be in the future (FAQ Q48).

**Comparison with ours (CODE `services/ledger/ledgerConsentService.js`, `services/consentService.js`, `schema.prisma` HealthConsent):**

| Property | ABDM consent artefact | Ours today |
|---|---|---|
| Unit | one artefact per requester (HIU) | one `HealthConsent` row per user, `scopes[]` array |
| Recipient | named HIU | none — no data leaves to third parties today |
| Purpose | coded (6 values) | implicit in scope name (`logs`, `nutrition`, `medical_records`, `location_routes`, `cycle_tracking`) |
| Data classes | `hiTypes[]` + care contexts | scope |
| Time window | `dateRange` of data + `dataEraseAt` | none |
| Expiry / re-consent | expires | never expires; **re-consent when wording changes** via `scopeVersions` + `LEDGER_POLICY_VERSION` (stale ⇒ gate closes) — stronger than ABDM here |
| Revocation | revoke; HIU must delete | revoke-not-delete (`purge=false` default) |
| Proof | CM-signed artefact | row + version map; `HealthDataAuditLog` records actor, not data |
| Ordering | — | ledger scopes require live device-level `HealthConsent` first (`addScope` → `HEALTH_CONSENT_REQUIRED`) |

Conclusion: our model is a good **collection** consent; it has no concept of **disclosure to a named recipient for a period**. That needs a new table (§D.4).

### B.6 Sandbox (VERIFIED `?doc=ABDMSandboxSignup`, `/sandbox/v3/sandbox-registration`)
- "Open to everyone including individuals." Form: integration type (ABDM/UHI/NHCX), entity type (Company, LLP, Partnership, Proprietorship…), GSTIN **optional at signup**, product, website, contact, solution type ("PHR", "Healthtech", "Health Locker", "EUA"…), intent (M1/M2/M3/M4/PHR App/Health Locker…).
- **No company documents at signup. GSTIN certificate + signed Undertaking (hard copy couriered to NHA) at exit.**
- Committee "meets only once a week … minimum of 7 days turnaround". No fee mentioned (treat as free — UNVERIFIED).
- Test limit: 100 ABHA creations per client ID (`ABDM-1227`).
- **Callbacks must use a domain (not IP) on an India-based server**; whitelist ABDM NAT IPs (FAQ Q29). Our Cloud Run is `asia-south1` (Mumbai) — fine. **Our Neon DBs are not in India** — see §D.7.
- **Is it a blocker for us?** Not for Stage 0. For Stage 1, only in that we should register under the *company* (being incorporated in UP) rather than as an individual, so the eventual certificate/listing is in the right name.

### B.7 Certification gates (VERIFIED `?doc=SandboxExit`, `?doc=AboutABDMSandbox`)
- Milestones: **M1** ABHA create/verify · **M2** link records (become HIP) · **M3** consent + fetch (HIU) · **M4** HFR/HPR native registration. PHR/Locker apps have their own "PHR and Locker V3 Test Cases" and their scope is **M1+M2+M3+Locker**; PHR apps must render **all 8 HI types** and support **Scan & Share** (FAQ Q2, `?doc=ABDMCompliant`, `?doc=ScanAndShare`).
- Exit: (1) **functional testing by one of 9 NHA-empanelled agencies, "on chargeable basis"**, ≤7 working days once onboarded, NHA template + internal demo; (2) **WASA** by an STQC or CERT-In empanelled agency → "Safe-to-Host" certificate; (3) **Health Tech Committee**: exit form + FT report + WASA cert + Undertaking + GSTIN, then demo; (4) production client ID/secret, test against production lab facility `IN0110005723`.
- Fees for FT and WASA: **not published** (VERIFIED by absence). UNVERIFIED market rates — get 2–3 quotes each.
- HPR/HFR registration: **not required for a PHR app** (M4 is separate). HPR today lists doctors, nurses, pharmacists; dietitians/physios **not listed** (UNVERIFIED against the live dropdown). Yoga/naturopathy professionals go to the Ayush NRB registry. https://nhpr.abdm.gov.in/nhpr/v4/home
- Realistic timeline for a small team (inference): **M1-only ≈ 2–3 months elapsed** (3–6 weeks build + sandbox + FT + WASA + HTC). **Full PHR ≈ 4–8 months.**
- Public listing: https://abdm.gov.in/our-partners (tabs incl. PHR App, Health Locker, Health Tech). ~34 PHR apps listed; newest 16/09/2026. **UNVERIFIED whether an M1-only integrator is listed** — ask NHA.
- Governance that binds once integrated: ABDM **Health Data Management Policy** (draft v2, Apr 2022) — applies to "all … ecosystem partners"; **cl. 26.6 "No personal data shall be stored beyond the geographical boundaries of India"**; annual independent audit; 1-month grievance SLA; breach notice to NHA. VERIFIED text https://thebastion.co.in/uploads/Draft_HDM_Policy_April2022_e38c82eee5.pdf ; 2020 sandbox framework's "servers reside in India" checklist https://abdm.gov.in/strapicms/uploads/sandbox_guidelines_b39bcce23e.pdf. UNVERIFIED whether a newer final HDMP exists.

### B.8 Crypto — Fidelius (VERIFIED `?doc=ImplementationGuidelines`, FAQ Q39–40)
- **ECDH on Curve25519 → HKDF → AES-256-GCM**; fresh key pair and 32-byte nonce per exchange; salt = first 20 bytes of `RAND(P) XOR RAND(U)`, IV = last 12 bytes; public keys uncompressed `04`-prefixed. M2 JSON carries `"curve": "Curve25519"`.
- **Required whenever a HIP/HRP pushes FHIR to an HIU through ABDM** — including a PHR/locker sharing user-uploaded records.
- **Not required** for: the user downloading their own file (Stage 0/1), or our own direct B2B share to an insurer outside ABDM (Stage 2 — we use TLS + a signed payload instead).
- Reference implementation: "Fidelius CLI" (Java) linked from the docs; NHA GitHub has `ABDM-wrapper`, `ABDM-MOCK-HIP` ("V3 API complaint Mock HIP"). UNVERIFIED exact repo the docs link.

### B.9 Government incentives (VERIFIED)
- **DHIS** (https://abdm.gov.in/DHIS): Corrigendum 7 "effective from the month of April 2026 till September 2026", subject to funds (text reproduced in a Rajasthan NHM letter: https://rajswasthya.rajasthan.gov.in/admin/upload/letter/2026/05/40%20Dt.05.05.2026%20NHM%20CSR%20NDHM%20(ABDM)-01779-PART-14.pdf). Corrigendum 6: https://abdm.gov.in/strapicms/uploads/20_Nov_2025_vf_DHIS_Corrigendum_6_dba5b58a53.pdf
- Digital Solution Company rate for **WellnessRecord linking: ₹2.5**, above a 100-transactions/month baseline, and only if the DSC's software is used by ≥10 facilities each >100/month; max 1 per ABHA/day, 5/month; **WASA + v3 compliance mandatory**; health-locker record-linking incentives discontinued; consent-share ₹5 to the source (HIP/private locker), ₹10 to the HIU; UHI ₹5 per transaction to the end-user app.
- Rough ceiling at 43 users: ~₹1,000/month theoretical maximum. **Revenue: negligible. Value: credibility only.** Confirmed.
- No DHIS round after Sep 2026 found (UNVERIFIED — it has been renewed in 6-month steps so far).
- None of the realistic grants (UP Startup Policy 2026, TIDE 2.0, NIDHI-SSP) scores ABDM integration.

### B.10 Adjacent findings that shape the design

| Finding | Source | Why it matters here |
|---|---|---|
| **IRDAI** Insurance Products Regs 2024, Sch. III cl. 4.2: insurers may reward "preventive and wellness habits", defined per product. Wellness guidelines IRDAI/HLT/REG/CIR/233/09/2020 name **gym-membership vouchers** and **renewal discounts "based on wellness regime followed"**; insurers may not promote one provider, must offer choice, may pay merchants only the redeemed reward value. | https://irdai.gov.in/documents/37343/366029/Guidelines+on+Wellness+and+Preventive+Features.pdf/f8fec368-a7fa-7f8f-0ffd-23590074a2ff?version=1.0&t=1631531569802&download=true · Master Circular annexure (circular not in the repealed list): https://www.actuariesindia.org/sites/default/files/inline-files/6.%20Annexure%20to%20Master%20Circular%20on%20Health%20Insurance%20Business%2029052024.pdf | The insurer thesis has a legal hook — **the insurer files the methodology; we are the measurement engine / redemption merchant**. UNVERIFIED: whether the 2020 circular is still operative after the 2024 overhaul (counsel). |
| IRDAI Health Master Circular 2024: "express consent … for sharing of medical records … **in every instance**" | https://www.actuariesindia.org/sites/default/files/inline-files/5.%20Master%20Circular%20on%20Health%20Insurance%20Business%202024.pdf | Per-share consent, not a blanket toggle. |
| **Apple 5.1.3(i):** health data may give a benefit "(such as a reduced insurance premium), provided that the app is submitted by the entity providing the benefit, and the data is not shared with a third party." | https://developer.apple.com/app-store/review/guidelines/ | **HealthKit-derived data can never reach an insurer from our app.** |
| **Google Health Connect:** prohibits "Transferring, selling, or using user health and fitness data to determine credit-worthiness, insurance eligibility". | https://support.google.com/googleplay/android-developer/answer/12991134 | Same for Health Connect — and "using" arguably covers **derived** scores. |
| **Aarogya Setu 2.0** launched 29 Jun 2026 as the government PHR: wearable sync, goal tracking, reminders, AI wellness insights. | PIB backgrounder 6 Jul 2026 https://static.pib.gov.in/WriteReadData/specificdocs/documents/2026/jul/doc202676912801.pdf | Position as **complementary** (plans + gym-verified adherence), never as a rival PHR. |
| **CDSCO final Medical Device Software guidance (2026):** wellness exclusion holds only if intended use names **no disease**; "behavior-change … platform intended to mitigate the progression of chronic diseases (e.g., Type 2 diabetes, hypertension)" is a device; "control of conception" is a medical purpose. | https://cdsco.gov.in/opencms/export/sites/CDSCO_WEB/Pdf-documents/Guidance-document-on-Medical-Device-Software-under-MDR-2017.pdf | Decision stands: **no coded or disease-named conditions, ever**. The FHIR export must not emit `Condition`. |
| **SPDI Rules 2011** (health = sensitive, written consent) and **CERT-In 2022** apply **now**; DPDP Rules phase 3 (~13 May 2027). DPDP s.9(3) bans behavioural monitoring of children. | https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf · https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf | Share consent must be specific and withdrawable; 18+ only. |

### B.11 Things that surprised me
1. **The best government backing for the insurer thesis is IRDAI, not ABDM.** ABDM's purpose codes don't even have a clean fit for it.
2. **Apple/Google rules are a harder constraint than Indian law** — and they reach into our own score (see §D.5: `ScoreDaySnapshot` is partly derived from Health Connect/HealthKit data when `HealthGoal.activityIsMeasured` is true).
3. **The ABDM docs openly invite wearable data into PHR apps**, then require a facility HIP ID to link it. Contradiction unresolved.
4. **The government now runs its own wellness PHR** (Aarogya Setu 2.0).
5. **Our "canonical builder" is narrower than assumed** (§C.0): it covers finished workout sessions and biometrics only.
6. **Our score day-close is client-triggered with a client-supplied `today`** (CODE `controllers/ledgerController.js` `closeScoreDay`, `today: req.query.today || req.params.localDate`). Fine for a personal chart, weak for "verified".
7. **The gym QR check-in method is not stored in health-service at all.** booking-service has `attendanceMethod` (`qr_scan`, `qr_geofence_self`, `manual_verify`, `manual_override`) and `attendedAt`; the event it sends health-service (`/internal/attendance-events`) carries only `userId, bookingId, gymId, attendedAt, idempotencyKey` (CODE `controllers/sessionController.js`).

---

## C. Schema → ABDM profile mapping

### C.0 What the code actually says (checked against §5 of the brief)

| Brief's claim | Code says | Verdict |
|---|---|---|
| 42 models, 27 enums, 1,639 lines | 42 models, 27 enums, **1,672 lines** (grew with `20260930120000_score_target`) | Confirmed (line count drifted) |
| Zero ABDM/ABHA/FHIR references | `grep -ril "abha\|abdm\|fhir"` over health-service `.js`/`.prisma` → none | Confirmed |
| No code systems; `BiometricEntry.unit` free text | Confirmed; `unit String`, "stored per row … so a later unit change never silently reinterprets old rows" | Confirmed — UCUM map needed |
| `localDate` is `'YYYY-MM-DD'` with no stored offset | Confirmed on every ledger model. **But** most rows also carry real UTC instants (`WorkoutSession.startedAt/endedAt`, `ExerciseRecord.startedAt/endedAt`, `createdAt` everywhere, `ScoreDaySnapshot.closedAt`), and the server hard-codes `Asia/Kolkata` for "today" in `biometricService.js` and `ledgerIntakeService.js`; attendance-attached sessions get `localDate` server-derived from `attendedAt` (`localDateIST`) | Confirmed, but the tension is smaller than feared — see §D.6 |
| `HealthCondition` deliberately uncoded | `label String`, `source String @default("user_stated")` | Confirmed |
| `gymId` bare cross-service int | `WorkoutSession.gymId Int?`, `bookingId Int?`; no name/geo | Confirmed |
| `ScoreDaySnapshot` has no IG home | Confirmed | Confirmed |
| `buildRangeSeriesService` is **the** canonical builder for "what happened in this range" | It returns **only** `sessions` (finished `WorkoutSession`s with volume) and `biometrics`. No food, plan completions, score snapshots, cardio records, daily activity, cycle. `buildFullExportService` reuses it **only for sessions**; everything else there is read directly. | **Partly refuted** — the builder must be *extended* (opt-in) for FHIR, see §D.1 |
| `exportCoverage.test.js` is the pattern | Hand-written `LEDGER_PROJECTIONS` contract checked (a) against schema fields and (b) against the export source by regex; plus export/erasure parity | Confirmed — FHIR gets its own contract block there |
| Migration convention | `prisma/migrations/YYYYMMDDHHMMSS_snake_name/migration.sql`, hand-authored, `"health"."Model"` qualified, `IF NOT EXISTS`, enums via `DO $$ … EXCEPTION WHEN duplicate_object`, long `--` rationale; parity test lists models in `LEDGER_MODELS` | Confirmed |
| `HealthCondition` → `Basic` or `Composition.note` | **R4 `Composition` has no `note` element**, and WellnessRecord sections only admit Observation/Condition/DocumentReference, so a `Basic` would sit outside the document | **Refuted** — see row below and §F.6 |

### C.1 Mapping table (target: IG 6.5.0 WellnessRecord)

> ⚠️ **CORRECTED 2026-09-30 after running the HAPI validator — read this before the table.**
> The first version of this table assumed that an *extensible* binding lets us put our own CodeSystem ("PG CodeSystem") in `Observation.code`. **That is wrong.** The NRCeS base `Observation` profile (IG 6.5.0) **closes the slicing on `Observation.code.coding` by system: a coding must be LOINC or SNOMED CT, nothing else**, and every WellnessRecord section profile inherits that rule. "Extensible" only lets you reach for *another LOINC/SNOMED* code outside the value set. The first build of Stage 0 failed with **36 errors** for exactly this reason (plus: Lifestyle values must be alcohol/tobacco CodeableConcepts; Women Health values must be Quantity|string; LOINC 29463-7 triggers the core `bodyweight` profile, which requires the vital-signs category).
>
> **What we do instead** (commit `1936c00` on `feature/fhir-export`):
> - Every Observation's main code is **LOINC**. Our own detail (sets, volume, RPE, protein, workout type) rides in `Observation.component`, whose code is *not* sliced.
> - Everything with **no LOINC/SNOMED concept at all** — the daily adherence score (OHLC + `rulesVersion`), plan-item ticks, self-rated stress, phone day-distance, cycle phases other than a period start — goes into **one `DocumentReference`** in the *Document Reference* section, as an `application/json` attachment in our own versioned format (`phoolgobhi.adherence-ledger` v1). It stays inside the conformant document and says plainly that it is our format.
> - **Result:** HAPI validator 6.10.4 against `ndhm.in#6.5.0`: **0 errors** offline, and **0 errors with `tx.fhir.org`** terminology (LOINC 41982-0, 55411-3, 80404-7 and every UCUM unit confirmed real). Remaining warnings are expected: "code not in the IG value set" for the extensible LOINC codes, "CodeSystem not found" for our component codes, and UCUM `{annotation}` advisories.
> - **What this means for the thesis:** the adherence score is *carried* by an ABDM-conformant document but is **not machine-readable as a standard observation** by any ABDM system. That sharpens §C.2: the score's value is only realised by a reader who understands our ledger format — i.e. a direct partner (insurer), not the ABDM network.

LOINC displays are copied from the NRCeS value sets where the code is in one (the LOINC slice makes `display` mandatory). "Ledger" = the JSON attachment described above.

| Our model | FHIR resource | IG profile / section | Status | Notes |
|---|---|---|---|---|
| **BiometricEntry** (`weight`) | Observation | `ObservationBodyMeasurement` / BodyMeasurement | **Maps cleanly** | LOINC 29463-7, UCUM `kg`, category **vital-signs** (required by core `bodyweight`). `effectiveDateTime` = `localDate` (day precision), `issued` = `createdAt`. VALIDATED |
| BiometricEntry (`body_fat`) | Observation | `ObservationBodyMeasurement` | **Maps cleanly** | LOINC 41982-0 (extensible; confirmed real), UCUM `%`. VALIDATED |
| BiometricEntry (`resting_hr`) | Observation | `ObservationVitalSigns` / VitalSigns | **Maps cleanly** | LOINC 8867-4 (in the value set), `/min`; "resting" said in `code.text` (a second custom coding is what the closed slice rejects). VALIDATED |
| BiometricEntry (`sleep_minutes`) | Observation | `ObservationPhysicalActivity` / PhysicalActivity | **Maps cleanly** | LOINC 93832-4 is in the IG's *physical-activity* value set (not Lifestyle). VALIDATED |
| BiometricEntry (`stress`) | — (ledger) | DocumentReference | **No standard home** | No LOINC/SNOMED concept for a 1–10 self-rating → ledger attachment |
| BiometricEntry (`steps`, `hrv`) | Observation | `ObservationPhysicalActivity` / `ObservationVitalSigns` | **Maps cleanly** | Steps LOINC 55423-8 `{steps}` (in VS); HRV LOINC 80404-7 `ms` (extensible, confirmed real via tx.fhir.org) |
| **WorkoutSession** (finished) | Observation | `ObservationPhysicalActivity` / PhysicalActivity | **Maps cleanly** (as a summary) | Code **LOINC 55411-3 Exercise duration** (extensible; confirmed real), value = minutes; `effectivePeriod` from real UTC `startedAt/endedAt`; components: workout type, completedSets, volumeKg, rpe. `type = rest` → omitted. VALIDATED |
| **ExerciseRecord** (cardio/yoga, GPS run) | Observation | `ObservationPhysicalActivity` | **Maps cleanly** | LOINC 55411-3, value = minutes; components: type, distance, calories (LOINC 41981-2), avg HR. **`source` healthkit/health_connect ⇒ excluded from any third-party share**. VALIDATED |
| DailyActivityMetric | Observation (+ ledger) | `ObservationPhysicalActivity` / VitalSigns | Partial | Steps 55423-8, active kcal 41981-2, resting HR 8867-4; day distance → ledger (no fitting LOINC). **Always HK/HC-sourced** ⇒ user download only, never shared |
| SessionExercise, WorkoutSet | — | — | **No home** | No structured-strength profile anywhere in the IG. Kept in JSON export; Stage 0 emits only session-level components |
| RunTrack (polyline, splits) | — | — | **No home** (and shouldn't have one) | A route is location data. Never in FHIR |
| **ScoreDaySnapshot** | — (ledger) | DocumentReference | **No standard home** | Cannot be an Observation (closed LOINC/SNOMED slice). In the ledger attachment: `localDate`, open/high/low/close, `paused`, `rulesVersion`, `recordedAt` (= `closedAt`). Breakdown lines never emitted (free text) |
| PlanItemCompletion | — (ledger) | DocumentReference | **No standard home** | In the ledger: `localDate`, `kind` (never the doctor-item title), `how`, `points`, `recordedAt` (reveals late ticks) |
| FoodLog (day totals) | Observation | `ObservationGeneralAssessment` / GeneralAssessment | Partial | **LOINC 9052-2 Calorie intake total** (in the general-assessment VS) = day kcal; protein + entry count as components. Not Lifestyle (its value must be an alcohol/tobacco CodeableConcept). Nutrient values are **our estimates** — `FoodItem.source` is `'estimate'` today; IFCT use needs NIN permission. VALIDATED |
| CyclePhaseEntry | Observation (+ ledger) | `ObservationWomenHealth` / WomenHealth | Partial, **opt-in only** | Period starts → **LOINC 8665-2 Last menstrual period start date**, `valueString` date (profile allows Quantity\|string). Other phases → ledger only. Only `source = user_logged`; **`predicted` never emitted**. Off by default per export; never shared |
| **MedicalDocument** | DocumentReference | DocumentReference section / `HealthDocumentRecord` | Partial, **deferred** | Needs bytes (signed URLs expire in 5 min). Stage 0: withheld with count + reason (same pattern as `buildFullExportService`). Stage 3: locker upload |
| **HealthCondition** | *(none)* | — | **Deliberately no home** | Decision: never a conformant `Condition`. Stage 0: **withheld from the FHIR bundle, count + reason reported** (still in the JSON DPDPA export) |
| HealthGoal, NutritionTarget | (Goal) | not in WellnessRecord | No home in 6.5.0 | Maybe CarePlan/Goal in 7.0.0 (UNVERIFIED). JSON only |
| PlanItem | (CarePlan) | not in WellnessRecord | No home in 6.5.0 | Doctor items must never become MedicationRequest/Statement — that is "we prescribe". JSON only |
| DoctorAppointment | (Appointment) | — | No home | JSON only |
| PersonalisationProfile (`injuryZones`, `programmingMode`) | — | — | No home | Injury zones are not a diagnosis; keep out |
| Patient identity (auth-service: name, gender; `HealthGoal.age`) | Patient | NRCeS Patient profile | Partial | We hold **age, not date of birth**. Stage 1 adds ABHA address as `Patient.identifier` |
| Gym (`gymId` → gym-service) | Organization / Location | — | Partial | Needs a gym-service round trip; Stage 0 emits `Organization.identifier` only (see §F.8) |
| Phool Gobhi itself | Organization / Device | Composition `author` | Maps | Author = Patient (self-reported) + Organization/Device (app) |
| HealthConsent, AssistantConsent, CycleTrackingProfile consent fields | (Consent) | — | No home | Internal |
| HealthDataAuditLog | (AuditEvent) | — | No home | Internal; never exported to third parties |
| Exercise, ExerciseFormVideo, WorkoutTemplate, TemplateExercise, WorkoutPlan, WorkoutPlanDay, UserActivePlan, WeeklyGoal | — | — | No home | Catalogue / preferences |
| AssistantConversation, AssistantMessage, AssistantMemory, AssistantRateLimitLog | — | — | No home, never | Chat transcripts are not health records |
| FoodItem, SavedMeal, SavedMealLine, FoodPhotoRequestLog, SuggestionFeedback, NudgeOptOut, NudgeLog, RetentionPolicy | — | — | No home | Operational |

Count per model (42): clean 3 · partial 4 (DailyActivityMetric, FoodLog, CyclePhaseEntry, MedicalDocument) · carried only in the ledger attachment 2 (ScoreDaySnapshot, PlanItemCompletion) · no home 33. (Patient, Organization and gym rows above are identity resources built from auth/gym-service data, not health-service models.)

### C.2 What "no home" means — the honest answer on whitespace vs obstacle
- **It's both, split cleanly.** For **distribution through ABDM**, it's an obstacle: no HIU is asking for adherence OHLC or set-level strength data, and nothing in ABDM will route it anywhere useful. For the **insurer product**, it's whitespace: the IG has nothing competing with a frozen, rules-versioned adherence ledger, and IRDAI's wellness rules need exactly that kind of number.
- So: **FHIR is the packaging, not the channel.** The score reaches insurers through a direct, contracted, user-consented share (Stage 2), serialized as FHIR `Observation`s under our own CodeSystem so any system can parse it. ABDM becomes relevant for the score only if NHA answers the HIP-ID question favourably *and* an insurer becomes an ABDM HIU.

---

## D. Proposed architecture

### D.0 Layers — keep them separate so UHI/ABDM transport are additions, not rewrites

```
 ┌──────────────── RECORD LAYER (exists) ─────────────────┐
 │ health schema tables · consent gates · audit log        │
 └───────────────┬─────────────────────────────────────────┘
                 │  buildRangeSeriesService(userId, {from,to,include})   ← single builder
 ┌───────────────▼──────────────── PROJECTION LAYER ───────┐
 │  series JSON (existing)   seriesToCsv (existing)         │
 │  fhir/wellnessBundle.js   (NEW, pure, Stage 0)           │
 │  share/insurerGrade.js    (NEW, pure, Stage 2)           │
 └───────────────┬─────────────────────────────────────────┘
                 │  a FHIR Bundle / a signed summary — no knowledge of who receives it
 ┌───────────────▼──────────────── IDENTITY LAYER ─────────┐
 │  AbhaLink table + abdm/abhaClient.js (Stage 1, M1)       │
 └───────────────┬─────────────────────────────────────────┘
 ┌───────────────▼──────────────── TRANSPORT LAYER ────────┐
 │  user download (Stage 0/1) · direct insurer share (2)    │
 │  ABDM HIP/HRP + Fidelius (Stage 3, optional)             │
 │  UHI EUA — bookings, not records (Stage 4, later)        │
 └──────────────────────────────────────────────────────────┘
```
Rules: the serializer never imports anything ABDM; ABDM code never queries tables directly — it asks the projection layer for a Bundle. UHI (when it comes) touches booking-service, not this service.

### D.1 Stage 0 — FHIR serializer reusing the canonical builder

**Extend, don't fork, `buildRangeSeriesService`** (CODE `services/exportService.js`):
- Add an opt-in third key: `buildRangeSeriesService(userId, { from, to }, { include = [] } = {})`.
- Default `include = []` returns **exactly today's shape** (`sessions`, `biometrics`) so the FR-16 JSON/CSV export and `buildFullExportService` are byte-for-byte unchanged.
- `include` may add: `'exerciseRecords'`, `'dailyActivity'`, `'planCompletions'`, `'scoreSnapshots'`, `'foodDayTotals'`, `'cycleLogged'`. Each is a read of the same tables `buildFullExportService` already reads, projected once, here.
- Why: the Robin Hood rule ("an export and the on-screen numbers must never disagree") only holds if FHIR, JSON and CSV all project from one builder. A separate FHIR query path would be the parallel path the brief forbids.
- Each included row keeps its **provenance fields**: `source` (manual/healthkit/health_connect/gps_tracker), `createdAt` → `recordedAt`, and for sessions `bookingId`/`gymId`.

**New files** (no existing file's behaviour changes except the additive option):
- `services/fhir/wellnessBundle.js` — pure `seriesToWellnessBundle(series, { patient, author, generatedAt })` → FHIR R4 `Bundle` (`type: "document"`) whose first entry is a WellnessRecord `Composition`.
- `services/fhir/codeMaps.js` — `BiometricMetric` → LOINC + UCUM; free-text `unit` → UCUM (`kg`, `%`, `/min`, `min`, `{steps}`, `ms`); unknown unit → `valueQuantity` with `unit` only and no `system`, plus an entry in a `conversionWarnings` list returned beside the bundle.
- `services/fhir/codeSystems.js` — our CodeSystem URIs + codes (`workout-type`, `adherence-score-daily`, `plan-item-completed`, `stress-self-report`).
- Controller: `GET /api/health/export?format=fhir` inside the existing `exportMyData` (same `gated` middleware, same audit call with `dataType: 'fhir'`). Behind a new app-config flag, **off** in Stage 0.

**Withheld sections are reported, not silently dropped** (the `buildFullExportService` medical-records pattern): the response is
```json
{ "data": { "bundle": { …FHIR… },
            "withheld": [
              { "kind": "HealthCondition", "count": 2, "reason": "self-reported conditions are never coded or emitted as FHIR Condition" },
              { "kind": "MedicalDocument", "count": 1, "reason": "documents are not embedded; download each via the medical-documents screen" },
              { "kind": "CyclePhaseEntry", "count": 0, "reason": "included only when you choose it for this export" } ],
            "conversionWarnings": [] } }
```

**Tests** (house pattern):
- `test/exportCoverage.test.js`: add a `FHIR_PROJECTIONS` block — for each model the serializer reads, the fields it projects — checked against the schema and against `services/fhir/wellnessBundle.js` source, exactly like `LEDGER_PROJECTIONS`.
- New `test/fhirWellnessBundle.test.js` (`node:test`): (a) the same fixture series produces identical numbers in JSON, CSV and FHIR (the invariant, asserted); (b) no `Condition` resource is ever emitted; (c) no `CycleTrackingProfile`/predicted phase appears unless requested; (d) every `valueQuantity` has a UCUM `system` or a warning.
- Out-of-CI conformance check: a script that runs HAPI validator 6.2.1 `-ig https://nrces.in/ndhm/fhir/r4` over a fixture bundle and the founder's own export. **The "ABDM-conformant FHIR" claim is only made once this passes.**

**Cost:** ~1–2 engineer-weeks. **Approval needed:** none.

### D.2 Stage 1 — ABHA link storage (with migration SQL)

Where: **health-service, its own table**, not a column on auth-service's `User`.
- Why here: ABDM obligations (HDMP localisation, audit) attach to health data; keeping the identifier beside it keeps the regulated surface in one service and in the existing erasure/export plumbing. Why not a column: "no row" is the honest representation of "never linked", and a separate table keeps signup untouched.
- **We store the ABHA address and a masked number only. Never the Aadhaar number** (M1 rule), never the full ABHA number unless an M1 flow proves it necessary (§F.4).

Prisma model (to add under a new `// --- ABHA link (Stage 1) ---` block):
```prisma
enum AbhaEnvironment {
  sbx
  abdm

  @@schema("health")
}

// Optional, anchorable, never required. A row exists only while a user has
// chosen to link; unlinking clears the identifier and keeps only the dates, so
// "was this account ever anchored, and when" survives for audit without keeping
// an identifier whose purpose has ended.
model AbhaLink {
  userId           Int             @id
  environment      AbhaEnvironment
  abhaAddress      String?         // 'name@abdm' | 'name@sbx'; null after unlink
  abhaNumberMasked String?         // '91-XXXX-XXXX-1234'; never the full number
  kycVerified      Boolean         @default(false) // ABHA number (KYC) vs self-declared address
  linkedVia        String          // 'aadhaar_otp' | 'abha_login' | 'mobile_otp'
  linkedAt         DateTime
  lastVerifiedAt   DateTime?
  unlinkedAt       DateTime?
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  @@unique([environment, abhaAddress])
  @@schema("health")
}
```

Migration `prisma/migrations/20261005000000_add_abha_link/migration.sql`:
```sql
-- Optional ABHA anchoring (Stage 1 of docs/ABHA-FHIR-INTEGRATION.md).
--
-- Purely additive: no existing table changes, every user starts with no row,
-- and nothing in signup reads this. A row means "this user chose to link";
-- the absence of a row is the normal state and must stay that way.
--
-- abhaAddress is nullable so an unlink can erase the identifier while keeping
-- linkedAt/unlinkedAt: the purpose of holding the address ends at unlink, the
-- fact that a link existed does not.
--
-- (environment, abhaAddress) is unique so one ABHA cannot anchor two Phool Gobhi
-- accounts, and sandbox '@sbx' links can never collide with production ones.
-- Postgres treats NULLs as distinct, so unlinked rows never block a re-link.

DO $$ BEGIN
  CREATE TYPE "health"."AbhaEnvironment" AS ENUM ('sbx', 'abdm');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "health"."AbhaLink" (
  "userId"           INTEGER NOT NULL,
  "environment"      "health"."AbhaEnvironment" NOT NULL,
  "abhaAddress"      TEXT,
  "abhaNumberMasked" TEXT,
  "kycVerified"      BOOLEAN NOT NULL DEFAULT false,
  "linkedVia"        TEXT NOT NULL,
  "linkedAt"         TIMESTAMP(3) NOT NULL,
  "lastVerifiedAt"   TIMESTAMP(3),
  "unlinkedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AbhaLink_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AbhaLink_environment_abhaAddress_key"
  ON "health"."AbhaLink" ("environment", "abhaAddress");
```
Also, in the same change: add `AbhaLink` to `deleteAllDataService` and `buildFullExportService`, to `LEDGER_PROJECTIONS`/erasure parity in `exportCoverage.test.js`, and to `LEDGER_MODELS` + `LEDGER_ENUMS` in `schemaMigrationParity.test.js` (or a sibling list — those lists are named "ledger" but are the only parity net).

In FHIR: `Patient.identifier` gets `{ system: "https://healthid.abdm.gov.in", value: <abhaAddress> }` — **UNVERIFIED: the exact identifier system URI the NRCeS Patient profile expects; check the profile before Stage 1.**

M1 client: `services/abdm/abhaClient.js` (V3 endpoints only, RSA-OAEP-SHA1 encryption of OTP/Aadhaar with the key from `/v3/profile/public/certificate`, base URLs per environment from B.2/FAQ Q3). Dev flavor → `sbx`; prod flavor → `abdm` only after certification.

### D.3 Consent — how new scopes fit with `nutrition` and `medical_records`

Two different kinds of consent; don't mix them:

| | **Collection consent** (exists) | **Disclosure consent** (new) |
|---|---|---|
| Question | "May Phool Gobhi store this about me?" | "May Phool Gobhi send *this summary* to *this recipient* for *this period*?" |
| Shape | scope on `HealthConsent.scopes` + `scopeVersions` | one row per recipient per grant |
| Expiry | none (re-consent on wording change) | always expires (default 6 months, max 12) |
| Revocation | stops collection; purge is separate | stops future disclosures; prior disclosures listed |

- **ABHA linking** gets its own collection scope `abha_link` on `HealthConsent.scopes`, version-stamped via the existing `addScope`/`LEDGER_POLICY_VERSION` machinery (bump to a new policy date when the copy ships).
  - Caveat (CODE): `addScope` requires a live device-level `HealthConsent`, and `grantConsentService` requires `platform ∈ {ios, android}` — i.e. the root consent is modelled as the HealthKit/Health Connect grant. **ABHA linking and sharing must not depend on HealthKit consent** (the insurer path explicitly excludes that data). So: either (a) create the root `HealthConsent` row without triggering the OS prompt, or (b) keep `abha_link` on `AbhaLink` itself with its own `consentVersion` column. Recommendation in §F.2.
- **Per-recipient, expiring disclosure → yes, a new table is needed.** Nothing in the current model can express "Acme Insurance, adherence summary v1, Oct–Mar, expires 31 Mar, revocable".

### D.4 Disclosure tables (Stage 2 sketch)

```prisma
// One user's permission for one recipient to receive one data class for one
// window. Modelled on the ABDM consent artefact (requester, purpose, data
// class, date range, erase-by, frequency) so a later move onto ABDM consent is
// a mapping, not a redesign.
model ShareGrant {
  id             Int       @id @default(autoincrement())
  userId         Int
  recipientKey   String    // stable programme key from config, e.g. 'acme-wellness-2027'
  recipientName  String    // snapshot, so receipts stay readable if config changes
  purpose        String    // 'insurer_wellness_reward' | 'employer_wellness'
  dataClass      String    // 'adherence_summary_v1' — derived only, never raw rows
  periodFrom     String    // 'YYYY-MM-DD' local day
  periodTo       String?   // null = rolling until expiresAt
  frequency      String    // 'once' | 'monthly'
  expiresAt      DateTime  // hard stop; re-consent required after
  recipientEraseBy DateTime? // contractual deletion deadline (mirrors dataEraseAt)
  policyVersion  String    // wording shown, server-validated like addScope
  grantedAt      DateTime
  revokedAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  disclosures ShareDisclosure[]

  @@index([userId, revokedAt])
  @@schema("health")
}

// Every actual send. This is the user's receipt list and the evidence for any
// dispute. It records WHAT KIND and a hash of what was sent, never the payload.
model ShareDisclosure {
  id           Int        @id @default(autoincrement())
  grantId      Int
  grant        ShareGrant @relation(fields: [grantId], references: [id], onDelete: Restrict)
  userId       Int
  periodFrom   String
  periodTo     String
  rulesVersion String     // insurer-grade rules, e.g. 'ig-v1'
  payloadSha256 String
  signatureKeyId String   // which signing key (rotation)
  disclosedAt  DateTime   @default(now())

  @@index([userId, disclosedAt])
  @@schema("health")
}
```
Recipients live in a config file (no table) until there is more than one insurer. `onDelete: Restrict` because a disclosure receipt must outlive a revoked grant; on account erasure both go (erasure parity), but a hashed receipt may need retaining as evidence — **counsel question** (same reasoning `consentService.js` already applies to `HealthDataAuditLog`).

### D.5 The insurer-grade score (derived, no HealthKit/Health Connect inputs)

Why not just share `ScoreDaySnapshot.close`: **it is partly HK/HC-derived.** `NutritionTarget` switches to measured activity after 14 days (`HealthGoal.activityIsMeasured`, `targetEngine.bandForMeasuredBurn` over active kcal from `DailyActivityMetric`, which is always HK/HC), so `calories_on_target`/`calories_off_target` lines can rest on Health Connect data. Google's policy covers *using* that data for insurance eligibility. So the insurer gets a **separate, narrower computation**:

- Pure function `services/share/insurerGrade.js`, `IG_RULES_VERSION = 'ig-v1'`.
- **Allowed inputs:** gym attendance (booking-service `attendedAt` + `attendanceMethod`), finished `WorkoutSession`s with `bookingId`, manual `ExerciseRecord`s (`source ∈ {manual, gps_tracker}`), `PlanItemCompletion` ticks for `workout`/`habit`/`rest` items, weekly goal, paused days.
- **Excluded:** anything with `source ∈ {healthkit, health_connect}`, `DailyActivityMetric`, all nutrition targets and food logs (v1 — revisit when targets can be computed from intake-only activity), biometrics, cycle, conditions, doctor items, medical documents.
- **Output per period, every number labelled with its evidence level:**
  - `verified_partner` — `attendanceMethod = qr_scan` / `manual_verify` (gym staff witnessed)
  - `verified_geofence` — `qr_geofence_self` (poster QR + location)
  - `self_reported` — manual logs and ticks
  - `manual_override` reported separately, never counted as verified
  Plus: planned vs. done, paused days, and `recordedAt − localDate` lag stats (late entries).
- **Same function renders the on-screen preview and produces the payload**, so what the user approves is exactly what is sent (the Robin Hood rule applied to sharing).
- **Payload:** FHIR `Bundle` (`type: collection`) of `Observation`s under PG CodeSystem, signed as a detached JWS (Ed25519, key in Secret Manager, `kid` recorded on `ShareDisclosure`). No name beyond what the grant requires; ABHA address included only if the user linked and the recipient needs identity matching.
- **Small upstream change:** booking-service includes `attendanceMethod` in the `/internal/attendance-events` payload, and health-service snapshots `attendedAt` + `attendanceMethod` onto `WorkoutSession` (two nullable columns, additive migration). Snapshot-at-event-time is the house style (FoodLog nutrients, HealthGoal sex/age) and avoids a cross-service call at share time.

### D.6 `localDate` and "verified" — the real analysis
- **Format is not the blocker.** FHIR `dateTime` allows day precision (`"2026-09-30"`); a timezone is required only when hours/minutes are present. So day-level Observations are valid today.
- **Where we have instants, we use them:** sessions and cardio records emit `effectivePeriod` with real UTC `startedAt/endedAt`; attendance has server `attendedAt`.
- **Every Observation gets `issued` = `createdAt`** — the server's record of *when it was entered*. The gap between `effective` (the user's day) and `issued` (when they logged it) is exactly what an auditor wants: it exposes backfilling. We don't need a stored offset to show that.
- **The actual weakness is who decides the day**, not the missing offset:
  - `closeScoreDay` is client-triggered and defaults `today` to the day being closed; manual `WorkoutSession.localDate` is client-supplied; `PlanItemCompletion` is a self-attested tap.
  - For a personal chart that's fine. For an insurer it isn't — hence the insurer-grade score never reads `ScoreDaySnapshot` and labels every self-reported number as such.
- **Offset:** all current users are in India and the server already assumes `Asia/Kolkata`. Storing a per-row offset buys nothing for IST-only users. Cheapest correct fix when it matters: one IANA `timeZone` per user (profile-level), recorded on each `ShareDisclosure`. See §F.1.

### D.7 Gates before ABDM production (not before Stage 0–2)
- **India data residency.** HDMP cl. 26.6 and the sandbox checklist require India-only storage for ABDM-integrated personal data. Our Neon Postgres has no India region; the AI coach sends user text to Groq (outside India). Before Stage 3 production: ABDM-scope data (AbhaLink, anything received from ABDM) in an India-hosted store (e.g. Cloud SQL `asia-south1`), and **no ABDM-sourced data ever enters an LLM prompt**. UNVERIFIED: region of the `phool-gobhi-medical` GCS bucket — check.
- Company incorporated (UP), GSTIN, Undertaking.
- FT + WASA budget approved.

### D.8 Out of scope, and what each costs later

| Item | Why out now | Cost / trigger later |
|---|---|---|
| **UHI** | Needs M2; no wellness/physio category; pay-on-visit only | After Stage 3 M2. Revisit when labs/physio categories go live. DHIS pays the EUA ₹5/transaction (if extended) |
| **Fidelius crypto** | Only for ABDM data flow | Stage 3; reference Java CLI exists — ~1–2 weeks to wrap + test |
| **WASA** | Only for ABDM production | Paid, unpublished rates; also useful for insurer security questionnaires |
| **Functional testing (FT)** | Only for sandbox exit | Paid, ≤7 working days once onboarded |
| **Sandbox registration** | **Not a blocker for Stage 0** | Free, ~1 week; register once the UP company exists |
| **PHR app / Health Locker (M2+M3)** | 4–8 months; must render all 8 HI types + Scan & Share | Only if NHA confirms a non-facility PHR can link self-uploaded WellnessRecords, or labs/doctor roadmap becomes real |
| **HIU (pull labs/prescriptions)** | Records would land in `MedicalDocument` (storage only — CDSCO line holds) | Stage 3, purpose `PATRQT` |
| **HFR/HPR** | Gyms aren't facilities; we aren't one | Only a partner physio clinic could register itself |
| **NHCX** | Claims-only; no wellness flows | Irrelevant to adherence |
| **Coded conditions (SNOMED/ICD)** | Decision: never | — |

### D.9 Staged phasing

| Stage | What ships | User-visible? | Needs ABDM approval? | Independently valuable because… | Honest claim unlocked |
|---|---|---|---|---|---|
| **0** | builder `include` option; `fhir/` serializer; code maps; tests; HAPI validation script; flag off | No | **No** | Proves conformance; gives a real artefact to show investors/insurers | "Our health data model exports as validated FHIR R4 against ABDM's IG v6.5.0" |
| **1a** | "Download my health record (FHIR)" on the data-export screen | Yes | No | DPDPA portability in the national standard | "Download your record in India's national health-data format" |
| **1b** | AbhaLink + M1 flows in **sandbox** (dev flavor only) | Dev only | Sandbox access | De-risks M1; investor demo | (to investors only) "ABDM sandbox integration in progress" |
| **2** | insurer-grade score, ShareGrant/ShareDisclosure, signed payload, share UI; first insurer pilot as measurement engine + redemption merchant | Yes | **No** | The revenue thesis, legally anchored in IRDAI wellness rules | "Verified gym attendance, shared only with your permission" |
| **3** | M1 production (FT + WASA + HTC) after India residency; optionally PHR/locker + HIU + Fidelius | Yes | **Yes** | Government listing; ABHA-anchored identity for insurers | "ABDM-integrated: create or link your ABHA" (+ listing if NHA confirms) |
| **4** | UHI EUA for labs/physio | Yes | Yes | Real healthcare services | "Book labs and physios on the national network" |

### D.10 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| FHIR export disagrees with on-screen numbers | Med | High (breaks the ledger's premise) | Single builder + invariant test across JSON/CSV/FHIR |
| NRCeS value-set conformance fails | Med | Med | Extensible bindings allow PG codes; run HAPI before claiming |
| IG 7.0.0 publishes and changes profiles | Med | Low–Med | Serializer versioned (`igVersion` param); re-validate |
| HK/HC-derived data reaches an insurer | Low (if designed) | **Critical** (app removal) | Source filter in `insurerGrade.js` + a test asserting no HK/HC-sourced row can influence output |
| Insurer treats self-reported numbers as verified | Med | High (disputes) | Evidence level on every number; `manual_override` never "verified" |
| Client-triggered day close / backfill gaming | Med | Med | Insurer score ignores `ScoreDaySnapshot`; lag stats; server-side close cron (§F.5) |
| Sharing mistaken for insurance distribution (IRDAI licence) | Low–Med | High | No policy selling, no referral fees; data/wellness-service contract only; counsel |
| 2020 IRDAI wellness circular not operative post-2024 | Low–Med | Med | Counsel confirmation before first contract |
| Share consent not "express, every instance" | Low | High | Per-grant consent, receipts, expiry, per-disclosure log |
| ABDM production blocked by data residency | High (today) | Med | India-hosted store for ABDM scope before Stage 3 |
| NHA says non-facility PHR can't link WellnessRecords | Med | Low (for us) | Stage 0–2 don't depend on it |
| ABHA seen as creepy in a gym app | Med | Med | Never at signup; Health+ settings only; plain copy; optional forever |
| Condition text leaks into FHIR as `Condition` | Low | High (CDSCO + re-identification) | Test asserting zero `Condition` resources |
| IFCT data used without NIN permission | Med | Med | Seed is `'estimate'` today; don't switch `source` to `ifct2017` before written permission |
| DHIS/grant expectations | — | Low | Treated as zero revenue |

---

## E. Design & UI/UX flow

### E.1 Where ABHA linking lives
- **Not onboarding, not signup, not booking.** Asking for a government health ID before someone has booked a session is the highest-trust request a gym app can make at its lowest-trust moment.
- **Home:** Profile → Health+ → **Privacy & data** → "Health ID (ABHA)". One row, showing "Not linked" and a short line: "Optional. Lets you prove your record is yours when you share it."
- **Contextual entry point (Stage 2+):** inside the share flow, *only if* the chosen insurer programme asks for identity verification — "This programme can verify it's you with ABHA. Link now or share without it."
- Never nag: no badges, no push notifications, no "complete your profile" counters that include ABHA.
- Dev flavor shows a visible **SANDBOX** tag on this screen; prod flavor hides the row entirely until certification.

### E.2 Linking / consent flow (as the user experiences it)
1. **Intro sheet** — what ABHA is (one sentence), what we'll store ("your ABHA address, like *rohit@abdm*"), what we won't ("your Aadhaar number, your medical records"), and that it's optional. Buttons: *Continue* / *Not now*.
2. **Choose how:** "I have an ABHA" (ABHA address/number + OTP) · "Create one" (Aadhaar OTP — NHA's consent text shown verbatim, adapted for private entities).
3. **OTP screen** (the OTP comes from UIDAI/NHA, not us — say so).
4. **Confirm details:** show the name/year of birth ABDM returns next to what we have. If they differ, say so plainly (E.5) — don't block.
5. **Done:** "Linked: rohit@abdm. You can unlink any time." Row now shows the address, linked date, and *Unlink*.

### E.3 "Share my adherence" flow (the insurer thesis)
1. Entry: Health+ → **Share** → list of programmes (config). Each shows who runs it and what reward the *insurer* offers — we don't describe the reward as ours.
2. **Preview — exactly what will be sent**, rendered by the same function that builds the payload:
   - "Sessions planned: 12 · Attended: 11 (9 verified by gym QR, 2 by poster QR + location) · Logged by you: 3 extra · Paused days: 2"
   - A **"Not shared"** box: "Apple Health / Google Health Connect data, steps, heart rate, food diary, weight, cycle data, conditions, medical documents, chat."
3. **Choose period and duration:** "Share Oct–Mar, monthly, until 31 Mar 2027." Max 12 months.
4. **Consent screen** (copy in E.8). Confirm with device auth (biometric/PIN).
5. **Receipt:** "Sent to Acme Wellness on 1 Nov · covers October · [view]". Every disclosure appears in **Sharing history**.

### E.4 Revocation / unlink — what happens to data already shared
- **Unlink ABHA:** we clear the address and masked number immediately (row keeps only dates); future FHIR exports omit the identifier. Nothing is sent anywhere because nothing was sent via ABDM in Stages 1–2. Copy says exactly that.
- **Stop sharing with an insurer:**
  - **Future:** stops immediately — no more disclosures, grant marked revoked.
  - **Past:** we **cannot un-send** what was sent. The honest answer:
    - The recipient's contract (which our share terms require before any programme is listed) obliges deletion within N days of revocation or by `recipientEraseBy`, **except** what they must keep by law — e.g. a premium discount already applied is a record of their policy, not of our data.
    - The user sees the full list of past disclosures (dates, period covered, what kind) and the recipient's contact for deletion requests.
    - We record the revocation and notify the recipient programmatically.
  - What we will **not** do: claim the data is "deleted everywhere". That would be false.
- **Delete my account:** grants revoked, recipients notified, rows erased per erasure parity (receipt-retention question in §F.9).

### E.5 Error and edge states

| State | What the user sees | Behaviour |
|---|---|---|
| ABHA creation fails (Aadhaar OTP error, UIDAI down) | "Couldn't reach the ABHA service. Nothing was saved. Try again later." | No row written; retry allowed |
| Name / DOB mismatch | "Your ABHA says *Rohit S.*, born 1994. Your Phool Gobhi profile says *Rohitashwa Singh*. That's fine — we'll keep both. Insurers may use the ABHA name." | Link proceeds; `kycVerified` from ABDM; no profile overwrite |
| ABHA already exists (creating one) | "You already have an ABHA. Log in with it instead." | Switch to "I have an ABHA" (M1 new-vs-returning) |
| ABHA already linked to another Phool Gobhi account | "This ABHA is linked to another account. Contact support if that's not you." | Unique constraint; support path; never reveal the other account |
| Sandbox vs production | Dev: SANDBOX tag, `@sbx` addresses. Prod: row hidden until certified | `environment` column; prod API refuses `sbx` rows |
| User declines at the last step | "No problem — nothing was saved." | No row, no scope, no reminder |
| Share: recipient programme withdrawn | "Acme Wellness has ended this programme. Sharing stopped on 3 Jan." | Grants auto-revoked |
| Share: not enough verified data | "You have no verified gym visits in this period yet. Book a session to start." | Share button disabled; not an error |
| Policy wording changed | "We've updated what sharing means. Please review." | Stale grants stop disclosing (same as `isScopeStale`) |
| FHIR export has unit it can't map | Export still succeeds; "1 value couldn't be converted and was included as text" | `conversionWarnings` |

### E.6 Empty and loading states
- Export, no data: "Nothing to export yet. Your record starts with your first workout or check-in."
- Export building: progress with "Preparing your record…" (server builds it; no partial file).
- Sharing history empty: "You haven't shared anything. Your data stays with you unless you choose a programme."
- ABHA screen loading: skeleton row; never block the rest of Health+.

### E.7 Flow diagrams

**First-time linking**
```
Health+ ▸ Privacy & data ▸ Health ID (ABHA)
        │
   [Intro sheet] ──Not now──► back (nothing stored, no reminder)
        │ Continue
   ┌────┴─────────────┐
 I have an ABHA    Create one (Aadhaar OTP, NHA text)
   │                  │
 [OTP via ABDM]    [OTP via UIDAI] ──fails──► "Nothing saved" ─► retry
   │                  │   └─exists──► switch to "I have an ABHA"
   └──────┬───────────┘
    [Confirm details] ──mismatch──► show both, continue
          │
    already linked elsewhere? ──yes──► support path, stop
          │ no
    write AbhaLink + scope 'abha_link' (versioned)
          │
    "Linked: name@abdm" ─► row shows Unlink
```

**Re-consenting (wording changed or grant expiring)**
```
policy version bumped / grant expires in 14 days
        │
  in-app card (no push): "Review your sharing with Acme"
        │
   [Show old vs new wording] ─► Agree ─► new grant/version recorded
        │
      Decline / ignore ─► on expiry: disclosures stop, grant closed,
                          receipts remain in Sharing history
```

**Sharing**
```
Health+ ▸ Share ▸ pick programme
        │
  [Preview = exact payload] + ["Not shared" box]
        │
  [Period + duration ≤ 12 mo]
        │
  [Consent copy] ─► device auth
        │
  ShareGrant written ─► first disclosure built by insurerGrade.js
        │                    ├─ signed (JWS), hash stored on ShareDisclosure
        │                    └─ audit row (actor, data class — never values)
        ▼
  Receipt ─► Sharing history ─► Stop sharing (future stops; past listed)
```

### E.8 Copy suggestions (plain language)
- **ABHA intro:** "ABHA is India's free digital health ID. Linking it is optional. We'll only keep your ABHA address (like *name@abdm*) so you can prove this record is yours. We never see or keep your Aadhaar number, and linking doesn't share anything with anyone."
- **Aadhaar path:** show NHA's consent text verbatim (with "government" removed per NHA's rule for private entities), then: "The OTP is sent by UIDAI, not Phool Gobhi."
- **Unlink confirm:** "Unlink your ABHA? We'll delete the address we stored. Nothing has been sent to ABDM, so there's nothing to recall."
- **Share consent:** "Send **Acme Wellness** a monthly summary of your gym attendance from **Oct 2026 to Mar 2027**. It shows how many sessions you planned and attended, and how each was confirmed. It does **not** include Apple Health or Google Health Connect data, steps, heart rate, food, weight, cycle data, conditions or documents. You can stop any time. Stopping ends future summaries — Acme must delete what it already has within 30 days, except records it's required to keep by law."
- **Stop sharing:** "Stop sharing with Acme? No more summaries will be sent. Here's everything we've sent so far."
- **FHIR download:** "Download your record in FHIR — the format India's national digital health system uses. Doctors' and hospitals' software can read it. Some items (conditions you typed, uploaded documents) aren't included; we'll list them."

---

## F. Open questions for you (with my recommendation)

1. **Timezone offset.** Recommend **no per-row offset**. Use `issued = createdAt` for provenance, real instants where we have them, and add one per-user IANA `timeZone` (default `Asia/Kolkata`) only when a non-IST user exists; stamp it on each `ShareDisclosure`. A per-row offset is a migration across ~10 tables to solve a problem no current user has.
2. **Per-recipient consent.** Recommend **yes, new `ShareGrant` + `ShareDisclosure` tables** (§D.4), modelled on the ABDM artefact. And **decouple the root from HealthKit consent**: create a platform-agnostic root consent (or give `AbhaLink`/`ShareGrant` their own version columns) so sharing never requires granting HealthKit/Health Connect — the data we share excludes it anyway.
3. **ABHA storage location.** Recommend **health-service `AbhaLink`**, not auth-service `User`. Keeps signup untouched and keeps the future India-residency boundary around one service.
4. **Store the full ABHA number?** Recommend **address + masked number only** until an M1 flow proves the full number is needed.
5. **Server-side day close.** `closeScoreDay` is client-triggered with a client-supplied `today`. Recommend a server cron that closes yesterday (IST) for every ledger user, keeping the client call as a no-op/idempotent read. Not needed for the insurer score (which avoids snapshots), but it makes the ledger itself more defensible.
6. **HealthCondition in FHIR (arguing with §5).** `Composition.note` doesn't exist in R4, and a `Basic` can't be referenced from any WellnessRecord section. Recommend **exclude from the FHIR bundle entirely** and report the withheld count — it stays in the DPDPA JSON export. Consequence: a doctor reading the FHIR file won't see the user's self-described conditions; that's the price of "we never diagnose".
7. **UHI premise (arguing with §2).** Your reasons were 2022 proposals; the live blockers are M2, no wellness/physio category, and pay-on-visit only. Recommend keeping UHI out but **updating the internal rationale** so nobody later "discovers" the old rules are gone and reopens the decision on the wrong basis.
8. **Gym `Organization` in FHIR.** Recommend Stage 0 emits only `Organization.identifier` (`https://phoolgobhi.com/gym|<gymId>`); add name/address via one batched gym-service call per export only if a recipient asks. No denormalisation.
9. **Disclosure receipts on account deletion.** Keep a hashed receipt (no payload) as evidence, like `HealthDataAuditLog`, or erase everything? Recommend **keep the hash-only receipt**, confirm with counsel.
10. **Nutrition in the insurer score.** Recommend **exclude in `ig-v1`** (targets can be HK/HC-derived). Revisit with intake-only targets later.
11. **`manual_override` attendance.** Recommend reporting it as its own bucket, never as verified.
12. **Cycle data in FHIR download.** Recommend opt-in per export, `user_logged` only, never in any share.
13. **Where the insurer relationship sits legally.** Recommend a data/wellness-service contract, plus redemption-merchant terms (IRDAI 2020 circular (j)), no referral fees, no policy promotion — counsel to confirm the 2020 circular still applies.

---

## G. What I'd do next

1. **Highest-leverage first action: build Stage 0 and get a clean HAPI-validator run on a real export (the founder's account).** It turns "ABDM-conformant FHIR" from a claim into a checked fact, needs no approval, and everything else (download, ABHA, sharing) sits on top of it.
2. Add the `include` option to `buildRangeSeriesService` + the JSON/CSV/FHIR invariant test **first**, before the serializer, so the invariant exists before there's anything to break it.
3. In parallel (non-engineering): incorporate in UP → GSTIN → ABDM sandbox registration (intents M1 + PHR App + Health Locker); email NHA the two questions (HIP ID for non-facility PHR self-uploads; M1-only listing).
4. Ship Stage 1a (FHIR download) behind the flag; turn on for the founder, then everyone.
5. Booking-service event change (`attendanceMethod` in `/internal/attendance-events`) + the two snapshot columns on `WorkoutSession` — prerequisite for the insurer score, cheap, and useful for the ledger anyway.
6. Build Stage 1b (ABHA in sandbox, dev flavor) once sandbox credentials arrive.
7. Draft the share terms with counsel; approach one insurer that already runs a filed wellness programme; build Stage 2 against their requirements, not ahead of them.
8. Decide India residency (Cloud SQL `asia-south1` for ABDM scope) before spending on FT/WASA.
