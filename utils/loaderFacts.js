// Loader facts served underneath spinners/loading states across the website,
// partner-web, admin portal and both Flutter apps.
//
// Source of truth: content/loader-facts.json (one canonical file — clients
// never hardcode the list; they cache batches of it). The endpoint is
// offset/limit based so clients can keep a small rolling buffer (10 in use,
// 10 prefetched) instead of shipping the whole corpus to every install.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;

const content = JSON.parse(
  readFileSync(join(__dirname, '..', 'content', 'loader-facts.json'), 'utf8')
);

const ALL_FACTS = content.facts.map(({ id, text, audiences }) => ({ id, text, audiences }));

export const LOADER_FACTS_VERSION = content.version;
export const LOADER_FACTS_TOTAL = ALL_FACTS.length;

function factsForAudience(audience) {
  if (!audience) return ALL_FACTS;
  return ALL_FACTS.filter((f) => f.audiences.includes(audience));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function buildLoaderFactsPayload({ offset, limit, audience } = {}) {
  const pool = factsForAudience(audience);
  const total = pool.length;
  const size = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  // Wrap rather than 400: a client whose cursor is past the end (e.g. the
  // corpus shrank) should gracefully restart the cycle, never break a loader.
  const start = total === 0 ? 0 : ((clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER) % total) + total) % total;

  const facts = [];
  for (let i = 0; i < Math.min(size, total); i += 1) {
    const f = pool[(start + i) % total];
    facts.push({ id: f.id, text: f.text });
  }

  return {
    version: LOADER_FACTS_VERSION,
    total,
    offset: start,
    limit: size,
    nextOffset: total === 0 ? 0 : (start + size) % total,
    facts,
  };
}

export function loaderFactsETag(payload) {
  return `"${createHash('sha1').update(JSON.stringify(payload)).digest('hex')}"`;
}

export function loaderFactsHandler(req, res) {
  const payload = buildLoaderFactsPayload({
    offset: req.query.offset,
    limit: req.query.limit,
    audience: typeof req.query.audience === 'string' ? req.query.audience : undefined,
  });

  const etag = loaderFactsETag(payload);
  // Content changes on deploy, not per request; let the CDN/client reuse a
  // batch for a few minutes and revalidate cheaply afterwards.
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.set('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  return res.json(payload);
}
