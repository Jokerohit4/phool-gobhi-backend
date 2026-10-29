# Photo versus database-first text lookup: cost calculation

Checked 2026-10-29. Read-only dev queries; no paid benchmark calls.
Four successful dev recognition calls reporting gemini-3.6-flash have thinking telemetry:

| Input | Visible output | Thinking |
|---:|---:|---:|
| 2444 | 389 | 1097 |
| 2444 | 793 | 861 |
| 2444 | 396 | 1239 |
| 2444 | 405 | 1124 |

Means: input 2444, output 495.75, thinking 1080.25. This is a tiny dev sample, not a
production estimate. Older calls have unavailable thinking, and provider-error usage is
unavailable. Cached-token metadata for these calls is null: this calculation explicitly
assumes uncached standard rates, not verified invoice spend. No unavailable value is
silently treated as measured zero.

Pricing assumption version: google-gemini-3.6-flash-standard-2026-10-29, valid through
2026-12-31. Official rates: $0.75 per million input and $3.75 per million output including
thinking. Source https://ai.google.dev/gemini-api/docs/pricing#gemini-3.6-flash . Rates listed
there double on 2027-01-01. FX assumption version: planning-usdinr-95, fixed INR95/USD from
the roadmap; not an assertion about the settlement exchange rate. All figures exclude
GST/taxes, FX fees, hosting, database/storage, retries and any additional enrichment calls.

Formula INR = (input * 0.75 + (visibleOutput + thinking) * 3.75) / 1000000 * 95.

| Scenario | Inputs | Visible output | Thinking | INR per paid call |
|---|---:|---:|---:|---:|
| Photo, recorded dev token means at assumed list rates |2444|495.75|1080.25|0.735585|
| Text, conservative hypothetical (same output/thinking) |800|495.75|1080.25|0.618450|
| Text, illustrative lower-thinking hypothetical |800|450|300|0.3241875|
| Database hit | No AI call | No AI call | No AI call |0 provider cost|

Conservative per-paid-call difference: INR0.117135 (15.924%). Lower-thinking illustrative
difference: 55.928%. Text input, output and thinking have NOT been benchmarked: neither
percentage is an achieved saving or a guaranteed range. 800 input tokens is a planning
assumption for the no-image/no-catalogue text request, including prompt/schema overhead.

Example workload, assuming 80% of text searches hit accessible database entries and 20%
need exactly one successful AI call, using the conservative text scenario:
- 10,000 uncached successful photo recognition calls: INR7355.85.
- 10,000 typed searches: 2000 paid lookups = INR1236.90, average INR0.12369 per search.
- Difference INR6118.95, 83.1848% lower in this hypothetical workload.

The 80% database hit rate is an example, not observed. A photo may identify multiple dishes;
a text lookup describes one food. Compare per-meal workloads using actual dish counts,
cache hits, retries, failure usage and total calls before making a release or savings claim.
