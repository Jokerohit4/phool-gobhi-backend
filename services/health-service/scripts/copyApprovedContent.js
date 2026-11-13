#!/usr/bin/env node
// Copy APPROVED coach content from one environment's database to another
// (dev -> prod at release), so the founder reviews each item once, on dev.
//
//   SOURCE_DATABASE_URL=<dev> TARGET_DATABASE_URL=<prod> \
//     node scripts/copyApprovedContent.js [--lang=en|hinglish|hi] [--update]
//                                         [--reviewer=<target auth user id>]
//                                         [--apply --target-host=<host>]
//
// WHAT IT DOES
//
//   Reads every `approved` ExerciseContent and CoachArticle row from the source
//   and writes it to the target as `approved`. Pending and rejected rows are
//   never copied.
//
//   Exercises are matched by NAME (system exercises only, createdByUserId null),
//   the same way prisma/seed.js finds them, because ids differ per database.
//   An exercise missing on the target is reported and skipped: run the seeds
//   (prisma/seed.js, seedHomeTrack.js, seedBeginnerTemplates.js) there first.
//
// SAFE BY DESIGN
//
//   - Dry run by default: it prints the plan and writes nothing. Writing needs
//     --apply AND --target-host=<the target database host>, so a wrong
//     TARGET_DATABASE_URL cannot be written to by accident.
//   - Create-only by default. A target row that already exists with different
//     text (or not approved) is reported, never touched. --update replaces it
//     with the source's approved copy and bumps its version.
//   - Identical approved rows are left alone, so re-running is a no-op.
//   - reviewedBy is an auth user id, and those differ per environment, so it is
//     written as --reviewer (the founder's id on the TARGET) or left null.

import { pathToFileURL } from 'node:url';

const LANGS = ['en', 'hinglish', 'hi'];

export function parseArgs(argv) {
  const opts = { lang: null, update: false, apply: false, targetHost: null, reviewer: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--lang') opts.lang = String(value()).toLowerCase();
    else if (flag === '--update') opts.update = true;
    else if (flag === '--apply') opts.apply = true;
    else if (flag === '--target-host') opts.targetHost = String(value());
    else if (flag === '--reviewer') opts.reviewer = Number(value());
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (opts.lang !== null && !LANGS.includes(opts.lang)) throw new Error(`--lang must be one of ${LANGS.join(', ')}`);
  if (opts.reviewer !== null && !(Number.isInteger(opts.reviewer) && opts.reviewer > 0)) {
    throw new Error('--reviewer must be a positive integer (an auth user id on the target)');
  }
  return opts;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error('Database URL is not a valid URL');
  }
}

/// Checks the two URLs before anything connects. Returns the target host.
export function checkTargets({ sourceUrl, targetUrl, opts }) {
  if (!sourceUrl || !targetUrl) throw new Error('Set both SOURCE_DATABASE_URL and TARGET_DATABASE_URL.');
  if (sourceUrl === targetUrl) throw new Error('Source and target are the same database.');
  const targetHost = hostOf(targetUrl);
  if (opts.apply && opts.targetHost !== targetHost) {
    throw new Error(`--apply needs --target-host=${targetHost} (the host you are about to write to).`);
  }
  return targetHost;
}

const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function exerciseSame(src, dst) {
  return sameList(src.steps, dst.steps) && sameList(src.feelCues, dst.feelCues) && sameList(src.mistakes, dst.mistakes);
}

function articleSame(src, dst) {
  return src.title === dst.title && src.body === dst.body && src.kind === dst.kind;
}

export async function copyContent({ source, target, opts, log = console.log, now = () => new Date() }) {
  const report = {
    created: [], updated: [], unchanged: 0, differs: [], missingExercise: [], ambiguousExercise: [], failed: [],
  };
  const langWhere = opts.lang ? { lang: opts.lang } : {};
  const approvedFields = () => ({ reviewStatus: 'approved', reviewedBy: opts.reviewer ?? null, approvedAt: now() });

  // Upsert one row by its natural key, following the create-only / --update rules.
  async function place({ model, label, where, payload, same }) {
    const existing = await model.findFirst({ where });
    if (!existing) {
      if (opts.apply) await model.create({ data: { ...where, ...payload, ...approvedFields() } });
      report.created.push(label);
      return;
    }
    if (existing.reviewStatus === 'approved' && same(existing)) {
      report.unchanged += 1;
      return;
    }
    if (!opts.update) {
      report.differs.push(`${label} (target is ${existing.reviewStatus})`);
      return;
    }
    if (opts.apply) {
      await model.update({
        where: { id: existing.id },
        data: { ...payload, ...approvedFields(), version: { increment: 1 } },
      });
    }
    report.updated.push(label);
  }

  // Exercise content: map source exercise ids to target ids by name.
  const contents = await source.exerciseContent.findMany({ where: { reviewStatus: 'approved', ...langWhere } });
  const sourceIds = [...new Set(contents.map((c) => c.exerciseId))];
  const sourceExercises = sourceIds.length
    ? await source.exercise.findMany({ where: { id: { in: sourceIds } }, select: { id: true, name: true, createdByUserId: true } })
    : [];
  const nameById = new Map(sourceExercises.filter((e) => e.createdByUserId === null).map((e) => [e.id, e.name]));
  const names = [...new Set(nameById.values())];
  const targetExercises = names.length
    ? await target.exercise.findMany({ where: { name: { in: names }, createdByUserId: null }, select: { id: true, name: true } })
    : [];
  const targetIdsByName = new Map();
  for (const e of targetExercises) targetIdsByName.set(e.name, [...(targetIdsByName.get(e.name) ?? []), e.id]);

  for (const c of contents) {
    const name = nameById.get(c.exerciseId);
    const label = `exercise "${name ?? `#${c.exerciseId}`}" [${c.lang}]`;
    try {
      if (!name) { report.missingExercise.push(`${label}: not a system exercise on the source`); continue; }
      const ids = targetIdsByName.get(name) ?? [];
      if (ids.length === 0) { report.missingExercise.push(label); continue; }
      if (ids.length > 1) { report.ambiguousExercise.push(label); continue; }
      await place({
        model: target.exerciseContent,
        label,
        where: { exerciseId: ids[0], lang: c.lang },
        payload: { steps: c.steps, feelCues: c.feelCues, mistakes: c.mistakes },
        same: (dst) => exerciseSame(c, dst),
      });
    } catch (err) {
      report.failed.push(`${label}: ${err?.message || String(err)}`);
    }
  }

  // Articles: slug + lang is the same key in every environment.
  const articles = await source.coachArticle.findMany({ where: { reviewStatus: 'approved', ...langWhere } });
  for (const a of articles) {
    const label = `article ${a.slug} [${a.lang}]`;
    try {
      await place({
        model: target.coachArticle,
        label,
        where: { slug: a.slug, lang: a.lang },
        payload: { kind: a.kind, title: a.title, body: a.body },
        same: (dst) => articleSame(a, dst),
      });
    } catch (err) {
      report.failed.push(`${label}: ${err?.message || String(err)}`);
    }
  }

  report.sourceApproved = contents.length + articles.length;
  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  const targetHost = checkTargets({ sourceUrl, targetUrl, opts });
  console.log(`Copy approved coach content: ${hostOf(sourceUrl)} -> ${targetHost}${opts.lang ? ` lang=${opts.lang}` : ''}${opts.update ? ' (--update)' : ''}`);
  console.log(opts.apply ? 'APPLYING: writes will be made to the target.' : 'Dry run: nothing will be written. Add --apply --target-host=<host> to write.');

  const { PrismaClient } = await import('@prisma/client');
  const source = new PrismaClient({ datasourceUrl: sourceUrl });
  const target = new PrismaClient({ datasourceUrl: targetUrl });
  try {
    const r = await copyContent({ source, target, opts });
    const verb = opts.apply ? '' : 'would be ';
    console.log(`source approved ${r.sourceApproved}; ${verb}created ${r.created.length}; ${verb}updated ${r.updated.length}; unchanged ${r.unchanged}; differs (skipped) ${r.differs.length}; missing exercise ${r.missingExercise.length}; ambiguous ${r.ambiguousExercise.length}; failed ${r.failed.length}.`);
    for (const x of r.differs) console.log(`  differs  ${x}  (use --update to replace)`);
    for (const x of r.missingExercise) console.log(`  missing  ${x}  (seed the target first)`);
    for (const x of r.ambiguousExercise) console.log(`  ambiguous ${x}  (two system exercises share this name on the target)`);
    for (const x of r.failed) console.log(`  failed   ${x}`);
    if (r.failed.length) process.exitCode = 1;
  } finally {
    await Promise.all([source.$disconnect().catch(() => {}), target.$disconnect().catch(() => {})]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`copyApprovedContent: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
