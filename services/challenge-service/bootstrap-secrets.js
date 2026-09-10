// Cloud Run mounts SECRETS_JSON (one consolidated Secret Manager secret) instead
// of one secret per key, to cut per-cold-start Secret Manager access calls.
// Must be the first import in the entrypoint: ESM evaluates imports in
// declaration order, and several modules read individual secret env vars
// (e.g. INTERNAL_API_KEY) at module top level, not lazily inside functions.
if (process.env.SECRETS_JSON) {
  const secrets = JSON.parse(process.env.SECRETS_JSON);
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
  }
}
