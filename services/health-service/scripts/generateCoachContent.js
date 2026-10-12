#!/usr/bin/env node
// Generate coach content for founder review (B15).
//
//   node scripts/generateCoachContent.js --batch=1 --lang=en [--dry-run] [--limit=N]
//   node scripts/generateCoachContent.js --batch=1 --lang=hinglish   (or --lang=hi)
//
// WHAT IT DOES
//
//   --lang=en          writes English coaching notes for every exercise used by a
//                      system (seeded) workout template, plus the five first-visit
//                      articles. Only rows that do not exist yet are generated.
//   --lang=hinglish|hi translates APPROVED English rows only, so a translation is
//                      never made from text the founder has not signed off.
//
// SAFE BY DESIGN
//
//   - Every row is written as `pending`. Nothing reaches a user until an admin
//     approves it in the content review queue.
//   - Existing rows are never overwritten (create-only), so re-running cannot
//     replace reviewed copy, and an interrupted run simply resumes.
//   - Model output is shape-checked and refused when it mentions a dose with a
//     supplement or medicine word, or a cure claim; refused items are reported
//     and skipped, never written.
//   - --dry-run makes no LLM calls and no writes. With no reachable database it
//     still prints the article plan and says the exercise list was skipped.
//
// Uses the AI coach's own provider (services/assistant/providers), configured by
// ASSISTANT_PROVIDER_BASE_URL / _API_KEY / _MODEL — no second LLM vendor.

import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(here, 'content');

export const FIRST_VISIT_ARTICLES = [
  { slug: 'what-to-bring', title: 'What to bring on day one', brief: 'What to pack for a first gym visit: clothes, shoes, water bottle, small towel, lock, ID or booking QR; what you do not need to buy yet.' },
  { slug: 'day-one', title: 'Your first day at the gym', brief: 'What happens on a first visit: reception, check-in, asking for a walk-around, warming up, doing a short easy session, and that feeling lost is normal.' },
  { slug: 'gym-etiquette', title: 'Gym manners nobody tells you', brief: 'Wipe equipment, re-rack weights, share machines between sets, do not hover, headphones, asking to work in, keeping phone calls outside.' },
  { slug: 'machine-basics', title: 'Using machines without fear', brief: 'How to adjust a seat and pin, start light, move slowly, read the picture on the machine, and ask the floor trainer to show you once.' },
  { slug: 'protein-myths', title: 'Protein: what reels get wrong', brief: 'Common protein myths from social media; that everyday Indian food can cover most needs; no powders or amounts; a doctor or dietitian for anything specific.' },
];

const LANGS = ['en', 'hinglish', 'hi'];

// Same spirit as the AI coach's output filter: a number with a unit next to a
// supplement or medicine word, or a cure/treatment claim, is never shipped as
// coaching copy.
const DOSE = /\d+(\.\d+)?\s?(mg|mcg|µg|iu|ml|g|gm|grams?|milligrams?)\b/i;
const DRUG_WORDS = /(supplement|creatine|whey|protein powder|vitamin|tablet|capsule|pill|medicine|medication|steroid|pre-?workout|fat burner|dawai|dava|goli|सप्लीमेंट|दवा|गोली|टैबलेट|विटामिन)/i;
const CURE = /\b(cures?|treats?|heals?|reverses?)\b.*\b(disease|diabetes|thyroid|pcos|pcod|bp|blood pressure|cholesterol|arthritis)\b|इलाज/i;

export function unsafeReason(text) {
  const t = String(text || '');
  if (DOSE.test(t) && DRUG_WORDS.test(t)) return 'dose with a supplement or medicine word';
  if (CURE.test(t)) return 'cure or treatment claim';
  return null;
}

export function parseArgs(argv) {
  const opts = { batch: null, lang: 'en', dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--batch') opts.batch = Number(value());
    else if (flag === '--lang') opts.lang = String(value()).toLowerCase();
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--limit') opts.limit = Number(value());
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (opts.batch !== 1) throw new Error('--batch must be 1 (the only batch defined so far)');
  if (!LANGS.includes(opts.lang)) throw new Error(`--lang must be one of ${LANGS.join(', ')}`);
  if (opts.limit !== null && !(Number.isInteger(opts.limit) && opts.limit > 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return opts;
}

function loadPrompt(name) {
  return readFileSync(join(PROMPT_DIR, name), 'utf8');
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (values[k] ?? ''));
}

/// The model is asked for bare JSON; tolerate a ```json fence around it.
export function parseJsonReply(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(text);
}

function isLines(v, min, max) {
  return Array.isArray(v) && v.length >= min && v.length <= max
    && v.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 500);
}

export function validateExercise(obj) {
  if (!obj || !isLines(obj.steps, 1, 20) || !isLines(obj.feelCues, 1, 20) || !isLines(obj.mistakes, 1, 20)) {
    return 'reply is not {steps, feelCues, mistakes} as lists of lines';
  }
  return unsafeReason([...obj.steps, ...obj.feelCues, ...obj.mistakes].join('\n'));
}

export function validateArticle(obj) {
  if (!obj || typeof obj.title !== 'string' || !obj.title.trim() || typeof obj.body !== 'string' || !obj.body.trim()) {
    return 'reply is not {title, body}';
  }
  if (obj.title.length > 200 || obj.body.length > 20000) return 'reply too long';
  return unsafeReason(`${obj.title}\n${obj.body}`);
}

/// Exercises in batch 1: every exercise used by a system template (the seeded
/// beginner gym routines and the home track) — read from the database, not a
/// hard-coded list, so it follows the seeds.
export async function batchOneExercises(prisma) {
  const rows = await prisma.templateExercise.findMany({
    where: { template: { isSystem: true } },
    select: {
      exercise: {
        select: { id: true, name: true, equipment: true, primaryMuscles: true, muscleGroup: true },
      },
    },
  });
  const byId = new Map();
  for (const r of rows) if (r.exercise) byId.set(r.exercise.id, r.exercise);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function firstLine(err) {
  return String(err?.message || err).split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
}

async function ask(provider, prompt, report) {
  report.attempted += 1;
  const { content } = await provider.generate({
    systemPrompt: 'You write fitness coaching content. Reply with JSON only.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1500,
    timeoutMs: 60000,
  });
  return parseJsonReply(content);
}

/// The whole run, with prisma and the provider passed in so tests need neither
/// a database nor a network. Returns a report; never throws for one bad item.
export async function generate({ prisma, provider, opts, log = console.log }) {
  const report = { planned: 0, attempted: 0, created: 0, skippedExisting: 0, refused: [], failed: [] };
  // --limit caps model calls (cost), not successful writes.
  const limitReached = () => opts.limit !== null && report.attempted >= opts.limit;

  if (opts.lang === 'en') {
    let exercises = [];
    try {
      exercises = await batchOneExercises(prisma);
    } catch (err) {
      if (!opts.dryRun) throw err;
      log(`[dry-run] database not reachable (${firstLine(err)}); exercise list skipped.`);
    }

    for (const ex of exercises) {
      if (limitReached()) break;
      report.planned += 1;
      const exists = opts.dryRun ? null : await prisma.exerciseContent.findFirst({ where: { exerciseId: ex.id, lang: 'en' } });
      if (exists) { report.skippedExisting += 1; continue; }
      if (opts.dryRun) { log(`[dry-run] exercise ${ex.id} ${ex.name}`); continue; }
      try {
        const obj = await ask(provider, fill(loadPrompt('exercise_en.txt'), {
          EXERCISE_NAME: ex.name,
          EQUIPMENT: String(ex.equipment ?? ''),
          MUSCLES: (ex.primaryMuscles?.length ? ex.primaryMuscles : [ex.muscleGroup]).join(', '),
        }), report);
        const bad = validateExercise(obj);
        if (bad) { report.refused.push({ item: `exercise ${ex.id}`, reason: bad }); continue; }
        await prisma.exerciseContent.create({
          data: {
            exerciseId: ex.id, lang: 'en', steps: obj.steps, feelCues: obj.feelCues, mistakes: obj.mistakes,
            reviewStatus: 'pending',
          },
        });
        report.created += 1;
      } catch (err) {
        report.failed.push({ item: `exercise ${ex.id}`, error: err.message });
      }
    }

    for (const a of FIRST_VISIT_ARTICLES) {
      if (limitReached()) break;
      report.planned += 1;
      const exists = opts.dryRun ? null : await prisma.coachArticle.findFirst({ where: { slug: a.slug, lang: 'en' } });
      if (exists) { report.skippedExisting += 1; continue; }
      if (opts.dryRun) { log(`[dry-run] article ${a.slug}`); continue; }
      try {
        const obj = await ask(provider, fill(loadPrompt('article_en.txt'), { SLUG: a.slug, TITLE: a.title, BRIEF: a.brief }), report);
        const bad = validateArticle(obj);
        if (bad) { report.refused.push({ item: `article ${a.slug}`, reason: bad }); continue; }
        await prisma.coachArticle.create({
          data: { slug: a.slug, kind: 'first_visit', lang: 'en', title: obj.title.trim(), body: obj.body.trim(), reviewStatus: 'pending' },
        });
        report.created += 1;
      } catch (err) {
        report.failed.push({ item: `article ${a.slug}`, error: err.message });
      }
    }
    return report;
  }

  // Translations: approved English rows only.
  if (opts.dryRun) {
    log(`[dry-run] would translate every APPROVED English exercise and article into ${opts.lang} that has no ${opts.lang} row yet.`);
    try {
      const [ex, art] = await Promise.all([
        prisma.exerciseContent.count({ where: { lang: 'en', reviewStatus: 'approved' } }),
        prisma.coachArticle.count({ where: { lang: 'en', reviewStatus: 'approved' } }),
      ]);
      log(`[dry-run] approved English rows: ${ex} exercises, ${art} articles.`);
    } catch (err) {
      log(`[dry-run] database not reachable (${firstLine(err)}); counts skipped.`);
    }
    return report;
  }

  const template = loadPrompt('translate.txt');
  const sources = [
    ...(await prisma.exerciseContent.findMany({ where: { lang: 'en', reviewStatus: 'approved' } })).map((r) => ({ type: 'exercise', row: r })),
    ...(await prisma.coachArticle.findMany({ where: { lang: 'en', reviewStatus: 'approved' } })).map((r) => ({ type: 'article', row: r })),
  ];
  for (const { type, row } of sources) {
    if (limitReached()) break;
    report.planned += 1;
    const model = type === 'exercise' ? prisma.exerciseContent : prisma.coachArticle;
    const key = type === 'exercise' ? { exerciseId: row.exerciseId } : { slug: row.slug };
    const label = type === 'exercise' ? `exercise ${row.exerciseId}` : `article ${row.slug}`;
    if (await model.findFirst({ where: { ...key, lang: opts.lang } })) { report.skippedExisting += 1; continue; }
    const input = type === 'exercise'
      ? { steps: row.steps, feelCues: row.feelCues, mistakes: row.mistakes }
      : { title: row.title, body: row.body };
    try {
      const obj = await ask(provider, fill(template, { TARGET: opts.lang, JSON: JSON.stringify(input, null, 2) }), report);
      let bad = type === 'exercise' ? validateExercise(obj) : validateArticle(obj);
      if (!bad && type === 'exercise'
        && (obj.steps.length !== input.steps.length || obj.feelCues.length !== input.feelCues.length || obj.mistakes.length !== input.mistakes.length)) {
        bad = 'translation changed the number of lines';
      }
      if (bad) { report.refused.push({ item: label, reason: bad }); continue; }
      const data = type === 'exercise'
        ? { exerciseId: row.exerciseId, lang: opts.lang, steps: obj.steps, feelCues: obj.feelCues, mistakes: obj.mistakes, reviewStatus: 'pending' }
        : { slug: row.slug, kind: row.kind, lang: opts.lang, title: obj.title.trim(), body: obj.body.trim(), reviewStatus: 'pending' };
      await model.create({ data });
      report.created += 1;
    } catch (err) {
      report.failed.push({ item: label, error: err.message });
    }
  }
  return report;
}

async function main() {
  dotenv.config();
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Coach content: batch=${opts.batch} lang=${opts.lang}${opts.dryRun ? ' (dry run: no LLM calls, no writes)' : ''}`);

  let provider = null;
  if (!opts.dryRun) {
    const { getProvider, isProviderConfigured } = await import('../services/assistant/providers/index.js');
    if (!isProviderConfigured()) {
      throw new Error('Assistant provider is not configured (ASSISTANT_PROVIDER_BASE_URL / _API_KEY / _MODEL).');
    }
    provider = getProvider();
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const r = await generate({ prisma, provider, opts });
    console.log(`${opts.dryRun ? '[dry-run] planned' : 'planned'} ${r.planned}; created ${r.created} (pending review); already existed ${r.skippedExisting}; refused ${r.refused.length}; failed ${r.failed.length}.`);
    for (const x of r.refused) console.log(`  refused ${x.item}: ${x.reason}`);
    for (const x of r.failed) console.log(`  failed  ${x.item}: ${x.error}`);
    if (!opts.dryRun && r.created > 0) console.log('Review them in the admin Content queue before anything is served.');
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`generateCoachContent: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
