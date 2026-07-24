#!/usr/bin/env node
/*
 * Analytics event drift checker — scans every place an event name is emitted
 * (backend track()/ingest() calls, both Flutter apps' AnalyticsEvents
 * constants, the website's analytics helper) and fails if any event string
 * in code isn't listed in docs/analytics-events.json.
 *
 * This exists because a shipped event was silently renamed on 2026-07-22
 * (subscription_order_created/subscription_purchased -> subscription_purchased_wallet)
 * with nothing to catch it before it broke a live funnel. Wired as a hard
 * gate (Step 0) in .claude/commands/deploy.md — a deploy aborts on drift.
 *
 * Run:  node scripts/check-analytics-events.cjs
 * Exit: 0 = clean, 1 = drift found (or a scan target is unreadable).
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'analytics-events.json');
const SIBLINGS_ROOT = path.join(REPO_ROOT, '..'); // .../phool_gobhi

const EVENT_NAME_RE = /^[a-z][a-z0-9_]*$/;

function loadRegistry() {
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const names = new Set();
  for (const key of Object.keys(raw)) {
    if (key.startsWith('$')) continue;
    names.add(key);
  }
  return names;
}

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// Extracts quoted snake_case-looking string literals that appear as an
// argument to track(/ingest(/trackEvent(/sendEvent(/etc, including the simple
// two-branch ternary pattern actually used in this codebase, e.g.:
//   track(isNewUser ? 'signup_completed' : 'login_completed', ...)
//   track(gym.isApproved ? 'gym_approved' : 'gym_rejected', ...)
function findEventCallsInText(text, callNames = ['track', 'ingest', 'trackEvent', 'sendEvent']) {
  const found = [];
  const callRe = new RegExp(`\\b(?:${callNames.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = callRe.exec(text))) {
    // Skip function/export declarations (`export function track(...)`,
    // `function ingest(...)`) — only interested in call sites.
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/\bfunction\s*$/.test(before)) continue;
    const start = m.index + m[0].length;
    // Grab a bounded window forward — enough to cover a ternary + first arg,
    // not a whole statement (avoids pulling in unrelated later string args).
    const window = text.slice(start, start + 200);
    // Object-form call (e.g. ingest({ event: e.event, ... })) — the event
    // name is dynamic/runtime, not a literal to check; skip entirely.
    if (window.trimStart().startsWith('{')) continue;
    const lineNo = text.slice(0, m.index).split('\n').length;
    const strRe = /['"]([a-zA-Z0-9_]+)['"]/g;
    let sm;
    let count = 0;
    while ((sm = strRe.exec(window)) && count < 2) {
      // Stop once we hit the first comma at depth 0 after the string(s) —
      // approximate by stopping after we've seen a ternary's two branches or
      // a single literal followed by a comma.
      const name = sm[1];
      if (EVENT_NAME_RE.test(name)) {
        found.push({ name, line: lineNo });
      }
      count++;
      // If the char right after this match isn't part of a ternary ('?'/':'
      // preceding), stop after the first literal — this is the common case.
      const after = window.slice(sm.index + sm[0].length, sm.index + sm[0].length + 3);
      if (!after.trim().startsWith(':') && count === 1) {
        // Check whether a '?' appeared before this literal in the window —
        // if so, this was the ternary's condition-string false-positive area;
        // otherwise it's a plain single-arg call, so stop.
        const before = window.slice(0, sm.index);
        if (!before.includes('?')) break;
      }
    }
  }
  return found;
}

function scanBackend() {
  const results = [];
  const jsFiles = [
    ...walk(path.join(REPO_ROOT, 'services'), ['.js']),
    ...(fs.existsSync(path.join(REPO_ROOT, 'index.js')) ? [path.join(REPO_ROOT, 'index.js')] : []),
  ];
  for (const file of jsFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { name, line } of findEventCallsInText(text)) {
      results.push({ name, file: path.relative(REPO_ROOT, file), line });
    }
  }
  return results;
}

function scanDartConstants(appDir, appLabel) {
  const file = path.join(SIBLINGS_ROOT, appDir, 'lib', 'core', 'analytics', 'analytics_events.dart');
  if (!fs.existsSync(file)) {
    console.warn(`  (skipping ${appLabel}: ${file} not found — sibling repo not checked out here)`);
    return [];
  }
  const text = fs.readFileSync(file, 'utf8');
  const results = [];
  // Skip property-key constants (propRole, propGymId, ...) — only interested
  // in event-name constants, which this file's own convention never prefixes
  // with "prop".
  const re = /static const String\s+(\w+)\s*=\s*'([a-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(text))) {
    if (/^prop[A-Z]/.test(m[1])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    results.push({ name: m[2], file: `${appDir}/lib/core/analytics/analytics_events.dart`, line });
  }
  return results;
}

function scanWebsite() {
  const dir = path.join(SIBLINGS_ROOT, 'phool-gobhi-website');
  if (!fs.existsSync(dir)) {
    console.warn(`  (skipping website: ${dir} not found — sibling repo not checked out here)`);
    return [];
  }
  const results = [];
  // 'post' is included here (unlike the backend scan, where it would false-
  // positive on every axios.post(url, ...) call) because the website's
  // lib/analytics.ts wraps every event send in a local post(event, props)
  // helper — that's the one place actual event-name literals appear; every
  // other file only calls the named exports (track/trackScreen/trackCta/
  // identify), which take a caller-chosen event or property, not a literal
  // to check.
  const websiteCallNames = ['track', 'ingest', 'trackEvent', 'sendEvent', 'post'];
  for (const file of walk(path.join(dir, 'app'), ['.ts', '.tsx']).concat(
    walk(path.join(dir, 'components'), ['.ts', '.tsx']),
    walk(path.join(dir, 'lib'), ['.ts', '.tsx'])
  )) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { name, line } of findEventCallsInText(text, websiteCallNames)) {
      results.push({ name, file: path.relative(dir, file).replace(/\\/g, '/'), line, repo: 'phool-gobhi-website' });
    }
  }
  return results;
}

function main() {
  const registry = loadRegistry();
  console.log(`Loaded ${registry.size} known event names from docs/analytics-events.json\n`);

  const all = [
    ...scanBackend(),
    ...scanDartConstants('phool-gobhi-customer-app', 'customer app'),
    ...scanDartConstants('phool-gobhi-partner-app', 'partner app'),
    ...scanWebsite(),
  ];

  const missing = all.filter((r) => !registry.has(r.name));
  const seen = new Set(all.map((r) => r.name));
  const unused = [...registry].filter((n) => !seen.has(n));

  if (missing.length === 0) {
    console.log('✓ No drift — every event name found in code is in the registry.');
  } else {
    console.log(`✗ DRIFT: ${missing.length} event name(s) used in code but missing from docs/analytics-events.json:\n`);
    for (const m of missing) {
      console.log(`  ${m.name}  (${m.file}:${m.line})`);
    }
  }

  if (unused.length > 0) {
    console.log(`\n(info) ${unused.length} registry entr${unused.length === 1 ? 'y' : 'ies'} not observed in this scan (may be retired, or emitted from code this script can't see):`);
    console.log('  ' + unused.join(', '));
  }

  process.exit(missing.length === 0 ? 0 : 1);
}

main();
