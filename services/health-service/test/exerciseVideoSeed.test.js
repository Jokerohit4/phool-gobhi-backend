import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('video seed replaces reviewed references, preserves IDs and stays idempotent within public exercises', async () => {
  const videos = [
    { exercise: 'Bench', youtubeVideoId: 'bench-new', title: 'Bench technique', channelName: 'Actual channel', durationSeconds: 71 },
    { exercise: 'Plank', youtubeVideoId: 'plank-new', title: 'Plank technique', channelName: 'Actual channel', durationSeconds: 98 },
    { exercise: 'New', youtubeVideoId: 'new-video', title: 'New technique', channelName: 'Actual channel', durationSeconds: 42 },
  ];
  const replacements = [
    { exercise: 'Bench', oldId: 'bench-old', newId: 'bench-new' },
    { exercise: 'Plank', oldId: 'plank-old', newId: 'plank-new' },
  ];
  let rows = [
    { id: 10, exerciseId: 1, languageCode: 'en', youtubeVideoId: 'bench-old' },
    { id: 20, exerciseId: 2, languageCode: 'en', youtubeVideoId: 'plank-old' },
    { id: 21, exerciseId: 2, languageCode: 'en', youtubeVideoId: 'plank-new' },
    { id: 99, exerciseId: 99, languageCode: 'en', youtubeVideoId: 'bench-old' },
  ];
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  let disconnected;
  mock.module('node:fs', { namedExports: { readFileSync: (file) => JSON.stringify(String(file).endsWith('exerciseVideos.json') ? videos : replacements) } });
  mock.module('@prisma/client', { namedExports: { PrismaClient: class {
    exercise = { findFirst: async ({ where }) => {
      assert.equal(where.createdByUserId, null);
      return { id: { Bench: 1, Plank: 2, New: 3 }[where.name] };
    } };
    exerciseFormVideo = {
      findFirst: async ({ where }) => rows.find((row) => matches(row, where)),
      updateMany: async ({ where, data }) => { for (const row of rows.filter((row) => matches(row, where))) Object.assign(row, data); },
      deleteMany: async ({ where }) => { rows = rows.filter((row) => !matches(row, where)); },
      create: async ({ data }) => { rows.push({ id: 100 + rows.length, ...data }); },
    };
    $disconnect = async () => disconnected();
  } } });
  mock.method(console, 'log', () => {});
  for (const phase of ['initial', 'repeat']) {
    const done = new Promise((resolve) => { disconnected = resolve; });
    await import(`../prisma/seedVideos.js?${phase}`);
    await done;
    assert.equal(rows.length, 4);
    assert.equal(rows.find((row) => row.id === 10).youtubeVideoId, 'bench-new');
    assert.equal(rows.find((row) => row.id === 21).durationSeconds, 98);
    assert.equal(rows.find((row) => row.id === 99).youtubeVideoId, 'bench-old');
    assert.equal(rows.filter((row) => row.exerciseId === 3).length, 1);
    assert.ok(!rows.some((row) => row.id === 20));
  }
});
