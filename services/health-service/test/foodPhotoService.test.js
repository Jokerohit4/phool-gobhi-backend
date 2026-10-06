import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The service is tested with a mock prisma and a stubbed storage + recogniser,
// because what is being verified here is the part neither of those can decide:
// that a model proposal is matched to the RIGHT catalogue row, that a log is
// only written after the user confirms, that one photo the user did not own
// cannot be attached, and that the correction counter is measuring the thing
// its schema comment claims it measures.

const STORAGE = {
  saved: [],
  signed: 'https://signed.example/photo',
  deleted: [],
};

let recognizer = {
  calls: [],
  async recognizeFood(args) {
    this.calls.push(args);
    return {
      isFood: true,
      items: [{ name: 'dal', grams: 200, confidence: 0.8, nonVeg: false }],
      note: null,
      model: 'gemini-2.0-flash-001',
      tokensIn: 900,
      tokensOut: 40,
    };
  },
};

let svc;

beforeEach(async () => {
  STORAGE.saved = [];
  STORAGE.deleted = [];
  recognizer = {
    calls: [],
    async recognizeFood(args) {
      this.calls.push(args);
      return {
        isFood: true,
        items: [{ name: 'dal', grams: 200, confidence: 0.8, nonVeg: false }],
        note: null,
        model: 'gemini-2.0-flash-001',
        tokensIn: 900,
        tokensOut: 40,
      };
    },
  };

  svc = await import('../services/ledger/foodPhotoService.js');
});

// Collaborators are injected rather than monkey-patched. ESM namespaces are
// frozen, so assigning to a module's exports throws - which is the same reason
// the service takes `deps` the way it already takes `prisma`.
function deps(overrides = {}) {
  return {
    storage: {
      isAllowedMimeType: (m) => m.startsWith('image/'),
      savePhoto: async ({ userId }) => {
        const path = `food/${userId}/abc-123.jpg`;
        STORAGE.saved.push(path);
        return path;
      },
      signedPhotoUrl: async (p) => (p ? STORAGE.signed : null),
      deletePhotos: async (paths) => {
        STORAGE.deleted.push(...paths);
        return { deleted: paths.length, failed: [] };
      },
      ...overrides.storage,
    },
    getRecognizer: () => recognizer,
    isRecognizerConfigured: () => overrides.configured !== false,
  };
}

const DAL = {
  id: 11,
  name: 'Dal, cooked',
  aliases: ['dal', 'daal'],
  kcal: 116,
  proteinG: 9,
  carbsG: 16,
  fatG: 2.2,
  fibreG: 4,
  ironMg: 2.5,
  magnesiumMg: 28,
  calciumMg: 24,
  zincMg: 1.1,
  servings: null,
  nonVeg: false,
  createdByUserId: null,
  verified: false,
};

const RICE = {
  ...DAL,
  id: 12,
  name: 'Rice, cooked (white)',
  aliases: ['chawal', 'bhaat', 'white rice'],
  kcal: 130,
};

const FRIED_RICE = {
  ...DAL,
  id: 13,
  name: 'Vegetable fried rice',
  aliases: [],
  kcal: 180,
};

function mockPrisma(overrides = {}) {
  const catalogue = overrides.catalogue ?? [DAL, RICE, FRIED_RICE];
  const created = [];
  return {
    created,
    catalogue,
    foodItem: {
      findMany: async () => catalogue,
      findUnique: async ({ where }) => catalogue.find((f) => f.id === where.id) ?? null,
    },
    foodPhotoRequestLog: {
      count: async () => overrides.requestCount ?? 0,
      create: async (args) => ({ id: 1, ...args.data }),
      // `in`, not `??`: this mock needs to be able to say "no such claim" by
      // returning null, and `null ?? { id: 1 }` substitutes the fallback - so the
      // ownership test below silently exercised the allowed path instead of the
      // refused one. A mock that cannot express a denial cannot test a denial.
      findFirst: async () => ('claim' in overrides ? overrides.claim : { id: 1 }),
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    foodLog: {
      create: async (args) => {
        const row = { id: created.length + 1, ...args.data };
        created.push(row);
        return row;
      },
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
      count: async () => 0,
    },
    ...overrides.rest,
  };
}

const PHOTO_ARGS = { buffer: Buffer.from('JPEGBYTES'), mimeType: 'image/jpeg' };

test('a proposal becomes a catalogue candidate, and no FoodLog is written', async () => {
  const prisma = mockPrisma();
  const out = await svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() });

  assert.equal(out.isFood, true);
  assert.equal(out.items.length, 1);
  // The model's name is kept for display and for the correction metric, but the
  // logged food is OUR row, and every nutrient comes from our data.
  assert.equal(out.items[0].proposedName, 'dal');
  assert.equal(out.items[0].foodItemId, DAL.id);
  assert.equal(out.items[0].name, 'Dal, cooked');
  assert.equal(out.items[0].grams, 200);
  assert.equal(prisma.created.length, 0, 'recognise must not write a food log');
  assert.equal(prisma.foodPhotoRequestLogCount, undefined);
});

test('the cheapest correct match wins, not the first row returned', async () => {
  // "rice" against a catalogue that has both a plain rice and a fried rice. A
  // substring match that does not prefer the shorter name logs a plate of biryani
  // for someone who photographed plain rice.
  recognizer.recognizeFood = async () => ({
    isFood: true,
    items: [{ name: 'rice', grams: 150, confidence: 0.9, nonVeg: false }],
    note: null,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
  });

  const out = await svc.recognizePhoto(mockPrisma(), { userId: 7, ...PHOTO_ARGS, deps: deps() });
  assert.equal(out.items[0].foodItemId, RICE.id, 'plain rice beats vegetable fried rice');
});

test('an exact catalogue name beats a longer one that merely contains it', async () => {
  recognizer.recognizeFood = async () => ({
    isFood: true,
    items: [{ name: 'Dal, cooked', grams: 200, confidence: 0.9, nonVeg: false }],
    note: null,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
  });

  const out = await svc.recognizePhoto(mockPrisma(), { userId: 7, ...PHOTO_ARGS, deps: deps() });
  assert.equal(out.items[0].foodItemId, DAL.id);
});

test('a name we do not stock is reported, not silently dropped', async () => {
  recognizer.recognizeFood = async () => ({
    isFood: true,
    items: [
      { name: 'dal', grams: 200, confidence: 0.9, nonVeg: false },
      { name: 'kuttu ki chilla', grams: 90, confidence: 0.6, nonVeg: true },
    ],
    note: null,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
  });

  // An empty catalogue is the honest "we stock nothing you photographed" case.
  const prisma = mockPrisma({ catalogue: [] });
  const out = await svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() });

  assert.equal(out.items.length, 0);
  assert.equal(out.unmatched.length, 2);
  // A high unmatched rate is the signal that the CATALOGUE is the bottleneck,
  // not the model, and it is only visible if the names are reported.
  assert.equal(out.unmatched[0].name, 'dal');
});

test('a photo with no food is a 200-shaped answer, not a failure', async () => {
  recognizer.recognizeFood = async () => ({
    isFood: false,
    items: [],
    note: null,
    model: 'm',
    tokensIn: 10,
    tokensOut: 2,
  });

  const prisma = mockPrisma();
  const out = await svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() });

  assert.equal(out.isFood, false);
  assert.deepEqual(out.items, []);
  assert.equal(out.photoPath, 'food/7/abc-123.jpg', 'the photo is kept so the user can retry');
});

test('the request ledger records cost and outcome, and no names', async () => {
  let recorded = null;
  const prisma = mockPrisma();
  prisma.foodPhotoRequestLog.create = async (args) => {
    recorded = args.data;
    return { id: 1, ...args.data };
  };

  await svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() });

  assert.equal(recorded.outcome, 'ok');
  assert.equal(recorded.tokensIn, 900);
  assert.equal(recorded.tokensOut, 40);
  assert.equal(recorded.photoPath, 'food/7/abc-123.jpg');
  assert.equal(recorded.model, 'gemini-2.0-flash-001');
  // The userId is there - it is this user's own cost record - but nothing about
  // what was on the plate.
  assert.equal(recorded.userId, 7);
  assert.equal(JSON.stringify(recorded).includes('dal'), false);
});

test('a provider failure is a 502 and never leaks the provider message', async () => {
  recognizer.recognizeFood = async () => {
    const { ProviderError } = await import('../utils/providerError.js');
    throw new ProviderError('provider returned 400: inlineData=<photograph bytes>', {
      status: 400,
      code: 'PROVIDER_REJECTED',
    });
  };

  let recorded = null;
  const prisma = mockPrisma();
  prisma.foodPhotoRequestLog.create = async (args) => {
    recorded = args.data;
    return { id: 1, ...args.data };
  };

  await assert.rejects(
    () => svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() }),
    (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, 'PROVIDER_FAILED');
      assert.equal(err.message.includes('photograph'), false);
      return true;
    },
  );
  // The attempt was still billed, so the row has to exist or the failed call is
  // invisible in the cost ledger - which is exactly how a feature starts costing
  // more than it looks.
  assert.equal(recorded?.outcome, 'provider_error');
  // And the photo is still tracked, so the sweeper can reclaim it.
  assert.equal(recorded?.photoPath, 'food/7/abc-123.jpg');
});

test('an unconfigured provider is 503, which the app can explain', async () => {
  await assert.rejects(
    () =>
      svc.recognizePhoto(mockPrisma(), {
        userId: 7,
        ...PHOTO_ARGS,
        deps: deps({ configured: false }),
      }),
    (err) => err.status === 503 && err.code === 'PROVIDER_NOT_CONFIGURED',
  );
});

test('the rate limit is counted before the model is called, not after', async () => {
  const prisma = mockPrisma({ requestCount: 20 });
  recognizer.calls = [];

  await assert.rejects(
    () => svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() }),
    (err) => err.status === 429 && err.code === 'RATE_LIMITED',
  );
  // No photo stored and no money spent: the limit exists to bound spend, and a
  // limit checked after the call bounds nothing.
  assert.equal(STORAGE.saved.length, 0);
  assert.equal(recognizer.calls.length, 0);
});

test('a non-image is refused before anything is stored', async () => {
  await assert.rejects(
    () =>
      svc.recognizePhoto(mockPrisma(), {
        userId: 7,
        buffer: Buffer.from('%PDF-1.4'),
        mimeType: 'application/pdf',
        deps: deps(),
      }),
    (err) => err.status === 400 && err.code === 'UNSUPPORTED_IMAGE',
  );
  assert.equal(STORAGE.saved.length, 0);
});

test('confirm writes photo_confirmed logs carrying the proposal and the photo', async () => {
  // The model comes off the claim row, which is this service's own record of
  // what it called - see the ownership note on confirmPhotoLog.
  const prisma = mockPrisma({ claim: { id: 1, model: 'gemini-2.0-flash-001' } });
  const out = await svc.confirmPhotoLog(prisma, {
    userId: 7,
    photoPath: 'food/7/abc-123.jpg',
    localDate: '2026-09-29',
    slot: 'dinner',
    lines: [
      { foodItemId: DAL.id, grams: 200, proposedName: 'dal', confidence: 0.8, corrected: false },
      { foodItemId: RICE.id, grams: 150, proposedName: 'rice', confidence: 0.9, corrected: false },
    ],
    // A client claiming a different model must not be able to choose what the
    // per-model accuracy numbers get attributed to.
    model: 'some-other-model-the-caller-made-up',
  });

  assert.equal(out.logged, 2);
  assert.equal(out.corrections, 0);
  assert.equal(out.correctionRate, 0);
  assert.equal(prisma.created.length, 2);
  assert.equal(prisma.created[0].source, 'photo_confirmed');
  assert.equal(prisma.created[0].photoPath, 'food/7/abc-123.jpg');
  assert.equal(prisma.created[0].photoModel, 'gemini-2.0-flash-001');
  // The proposal is retained so the correction rate is debuggable rather than
  // just a number that went up.
  assert.equal(prisma.created[0].photoProposedName, 'dal');
  assert.equal(prisma.created[0].photoConfidence, 0.8);
  assert.equal(prisma.created[0].photoCorrections, 0);
});

test('the correction counter is what the schema comment says it is', async () => {
  const prisma = mockPrisma({ claim: { id: 1 } });
  const out = await svc.confirmPhotoLog(prisma, {
    userId: 7,
    photoPath: 'food/7/abc-123.jpg',
    localDate: '2026-09-29',
    slot: 'dinner',
    lines: [
      { foodItemId: DAL.id, grams: 200, proposedName: 'dal', corrected: true },
      { foodItemId: RICE.id, grams: 150, proposedName: 'rice', corrected: false },
      { foodItemId: FRIED_RICE.id, grams: 100, proposedName: 'rice', corrected: true },
    ],
  });

  // The launch metric: the share of lines the user had to fix. "More than half"
  // is the threshold named in the schema.
  assert.equal(out.corrections, 2);
  assert.equal(out.correctionRate, 0.6667);
  assert.equal(prisma.created.filter((r) => r.photoCorrections === 1).length, 2);
});

test("one user's photo cannot be attached to another user's log", async () => {
  // The request ledger is the ownership proof. Without it, any caller who could
  // name a uuid could attach someone else's meal to their own diary.
  const prisma = mockPrisma({ claim: null });
  await assert.rejects(
    () =>
      svc.confirmPhotoLog(prisma, {
        userId: 7,
        photoPath: 'food/9/someone-elses.jpg',
        localDate: '2026-09-29',
        slot: 'dinner',
        lines: [{ foodItemId: DAL.id, grams: 200 }],
      }),
    (err) => err.status === 403 && err.code === 'PHOTO_NOT_CLAIMED',
  );
  assert.equal(prisma.created.length, 0);
});

test('one bad line does not lose the lines the user did not touch', async () => {
  const prisma = mockPrisma({ catalogue: [DAL] });
  const out = await svc.confirmPhotoLog(prisma, {
    userId: 7,
    photoPath: 'food/7/abc-123.jpg',
    localDate: '2026-09-29',
    slot: 'dinner',
    lines: [
      { foodItemId: DAL.id, grams: 200, proposedName: 'dal' },
      { foodItemId: 9999, grams: 100, proposedName: 'ghost' },
    ],
  });

  assert.equal(out.logged, 1);
  assert.equal(out.rejected.length, 1);
  assert.equal(prisma.created.length, 1);
});

test('confirm with nothing selected is a 400, and logs nothing', async () => {
  const prisma = mockPrisma({ claim: { id: 1 } });
  await assert.rejects(
    () =>
      svc.confirmPhotoLog(prisma, {
        userId: 7,
        photoPath: 'food/7/abc-123.jpg',
        localDate: '2026-09-29',
        slot: 'dinner',
        lines: [],
      }),
    (err) => err.status === 400 && err.code === 'NO_LINES',
  );
});

test('a photo link is minted only for the owner', async () => {
  const prisma = mockPrisma();
  prisma.foodLog.findFirst = async ({ where }) =>
    where.userId === 7 ? { photoPath: 'food/7/abc-123.jpg' } : null;

  const out = await svc.getPhotoLink(prisma, { userId: 7, logId: 5, deps: deps() });
  assert.equal(out.url, STORAGE.signed);

  await assert.rejects(
    () => svc.getPhotoLink(prisma, { userId: 8, logId: 5, deps: deps() }),
    (err) => err.status === 404,
  );
});

test('a log with no photo is a 404, not a null link', async () => {
  const prisma = mockPrisma();
  prisma.foodLog.findFirst = async () => ({ photoPath: null });
  await assert.rejects(
    () => svc.getPhotoLink(prisma, { userId: 7, logId: 5, deps: deps() }),
    (err) => err.status === 404 && err.code === 'NO_PHOTO',
  );
});

test('the object is only released when the LAST line from that photo goes', async () => {
  const prisma = mockPrisma();
  prisma.foodLog.count = async () => 1;
  let out = await svc.releasePhotoIfUnreferenced(prisma, { photoPath: 'food/7/abc.jpg', deps: deps() });
  assert.equal(out.deleted, 0, 'a sibling line still shows this photo');
  assert.equal(STORAGE.deleted.length, 0);

  prisma.foodLog.count = async () => 0;
  out = await svc.releasePhotoIfUnreferenced(prisma, { photoPath: 'food/7/abc.jpg', deps: deps() });
  assert.equal(out.deleted, 1);
  assert.deepEqual(STORAGE.deleted, ['food/7/abc.jpg']);
});

// --- catalogue grounding ----------------------------------------------------

test('the recogniser is only shown curated rows, never custom user foods', async () => {
  const wheres = [];
  const prisma = mockPrisma();
  prisma.foodItem.findMany = async (args) => {
    wheres.push(args.where || {});
    return prisma.catalogue;
  };

  await svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() });
  // The FIRST findMany is the catalogue fetch folded into the prompt; that lane
  // is curated-only. (The later per-name search is allowed to reach the user's
  // own customs, exactly like the food picker does.)
  assert.ok(wheres.length >= 1);
  assert.equal(wheres[0].createdByUserId, null);
});

test('the curated catalogue is folded into the prompt so the model names exact rows', async () => {
  const prisma = mockPrisma();
  await svc.recognizePhoto(prisma, { userId: 7, ...PHOTO_ARGS, deps: deps() });

  const sent = recognizer.calls[0];
  assert.ok(sent.catalogueText.length > 0, 'a catalogue must actually be sent');
  // Both the canonical name and an alias reach the model; the instruction says
  // whatever it names must be spelled the way it sees it here.
  assert.ok(sent.catalogueText.includes('Dal, cooked'));
  assert.ok(sent.catalogueText.includes('daal'));
});

test('an exact grounded row is trusted, even when free text could never reach it', async () => {
  // The dialect->canonical case the catalogue field exists for: the model saw
  // "kuttu ki chilla" and names OUR row "Buckwheat flour chilla". No prefix
  // matcher will ever connect those two strings, so free text would dump the
  // item in `unmatched`. The grounded answer is the only path that works.
  const BUCKWHEAT = { ...DAL, id: 50, name: 'Buckwheat flour chilla', aliases: [] };
  recognizer.recognizeFood = async () => ({
    isFood: true,
    items: [{ name: 'kuttu ki chilla', catalogue: 'Buckwheat flour chilla', grams: 90, confidence: 0.81, nonVeg: true }],
    note: null,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
  });

  const out = await svc.recognizePhoto(
    mockPrisma({ catalogue: [BUCKWHEAT] }),
    { userId: 7, ...PHOTO_ARGS, deps: deps() },
  );
  assert.equal(out.unmatched.length, 0);
  assert.equal(out.items[0].foodItemId, BUCKWHEAT.id);
  // The model's own name still comes through for the correction metric.
  assert.equal(out.items[0].proposedName, 'kuttu ki chilla');
});

test('a low-confidence grounded row is not trusted and falls through to matching', async () => {
  // MIN_TRUSTED_CATALOGUE_CONFIDENCE: a model that hedged on an anchor ("maybe
  // this is dal") must not be taken at that word - the hedge leaks into the
  // match. It falls to free text, where the normal match still works.
  recognizer.recognizeFood = async () => ({
    isFood: true,
    items: [{ name: 'dal', catalogue: 'Dal, cooked', grams: 200, confidence: 0.2, nonVeg: false }],
    note: null,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
  });

  const out = await svc.recognizePhoto(mockPrisma(), { userId: 7, ...PHOTO_ARGS, deps: deps() });
  assert.equal(out.unmatched.length, 0);
  assert.equal(out.items[0].foodItemId, DAL.id);
});

test('an invented grounded name is reported as unmatched, never invented into a row', async () => {
  // The catalogue assertion is only honoured for names WE sent. A model that
  // invents "Paneer & greens" for a plate must not hand us a row that never
  // existed - and with an empty catalogue it gets nothing for it.
  recognizer.recognizeFood = async () => ({
    isFood: true,
    items: [{ name: 'Paneer & greens', catalogue: 'Paneer & greens', grams: 120, confidence: 0.95, nonVeg: false }],
    note: null,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
  });

  const out = await svc.recognizePhoto(
    mockPrisma({ catalogue: [] }),
    { userId: 7, ...PHOTO_ARGS, deps: deps() },
  );
  assert.equal(out.items.length, 0);
  assert.equal(out.unmatched[0].name, 'Paneer & greens');
});

// --- matched-but-unknown confirm lines ---------------------------------------

test('a confirmed unknown line is logged as pending, not dropped, and raises a request', async () => {
  let createdRequest = null;
  const prisma = mockPrisma({
    claim: { id: 1, model: 'gemini-2.0-flash-001' },
    rest: {
      foodRequest: {
        findFirst: async () => null,
        count: async () => 0,
        create: async (a) => ((createdRequest = a.data), { id: 9, ...a.data }),
      },
    },
  });

  const out = await svc.confirmPhotoLog(prisma, {
    userId: 7,
    photoPath: 'food/7/abc-123.jpg',
    localDate: '2026-09-29',
    slot: 'dinner',
    lines: [
      { unknown: true, name: 'Amla pickle, homemade', grams: 100, proposedName: 'Amla pickle', confidence: 0.71, corrected: false },
    ],
  });

  assert.equal(out.logged, 1);
  assert.equal(out.pending, 1);

  const row = prisma.created[0];
  assert.equal(row.source, 'photo_unmatched');
  assert.deepEqual(row.nutrients, { unknown: true });
  assert.equal(row.name, 'Amla pickle, homemade');
  assert.equal(row.foodItemId, null);
  assert.equal(row.photoPath, 'food/7/abc-123.jpg');
  assert.equal(row.photoProposedName, 'Amla pickle');
  // The dish reaches the missing-food queue under the photo lane.
  assert.equal(createdRequest.source, 'photo');
  assert.equal(createdRequest.name, 'Amla pickle, homemade');
});

test('an unknown line with no name falls back to the proposed name', async () => {
  const prisma = mockPrisma({
    claim: { id: 1 },
    rest: { foodRequest: { findFirst: async () => null, count: async () => 0, create: async (a) => ({ id: 9, ...a.data }) } },
  });

  const out = await svc.confirmPhotoLog(prisma, {
    userId: 7,
    photoPath: 'food/7/abc-123.jpg',
    localDate: '2026-09-29',
    slot: 'lunch',
    lines: [{ unknown: true, proposedName: 'Kadai paneer saag', grams: 120, corrected: false }],
  });

  assert.equal(out.pending, 1);
  assert.equal(prisma.created[0].name, 'Kadai paneer saag');
});

test('a request-queue refusal does not lose the pending log', async () => {
  // The cap bounds the shared queue, not the diary. logging what you ate must
  // not depend on the queue accepting a new row.
  const prisma = mockPrisma({
    claim: { id: 1 },
    rest: { foodRequest: { findFirst: async () => null, count: async () => 999, create: async () => { throw new Error('must not create'); } } },
  });

  const out = await svc.confirmPhotoLog(prisma, {
    userId: 7,
    photoPath: 'food/7/abc-123.jpg',
    localDate: '2026-09-29',
    slot: 'dinner',
    lines: [{ unknown: true, name: 'Keema kaleji', grams: 90, corrected: false }],
  });

  assert.equal(out.logged, 1);
  assert.equal(out.pending, 1);
  assert.equal(prisma.created[0].source, 'photo_unmatched');
});
