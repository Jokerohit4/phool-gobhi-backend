// In-memory stand-in for the buddy-service PrismaClient, shared by the
// buddy test files. Not a test file itself (node --test still loads it, finds
// no tests, and moves on).
//
// Unlike a per-method stub, this evaluates `where` clauses for real: AND / OR /
// NOT, to-one relation filters (`filter: { is: ... }`), scalar-list operators
// (has / hasSome / isEmpty / equals), and SQL NULL semantics (a comparison
// against NULL is false). That is the point: the buddy safety rules live in
// the WHERE clause (targetEligibility), and a mock that ignored `where` would
// pass no matter what the query said.
//
// Each model is backed by a Map the test owns, so tests can seed and inspect
// rows directly. swipe and blockedUser are keyed "a-b" (swiperId-swipeeId,
// blockerId-blockedId) to match the existing tests; everything else by id.

const ENUM_RANK = {
  // Postgres orders an enum by declaration order, not alphabetically.
  severity: { normal: 0, high: 1 },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function cmpValue(v) {
  return v instanceof Date ? v.getTime() : v;
}

function eq(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]));
  }
  return cmpValue(a) === cmpValue(b);
}

const SCALAR_OPS = new Set(['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'has', 'hasSome', 'hasEvery', 'isEmpty']);

function matchScalar(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (!isPlainObject(cond)) return eq(value, cond);
  const isNull = value === null || value === undefined;
  for (const [op, arg] of Object.entries(cond)) {
    if (!SCALAR_OPS.has(op)) throw new Error(`fakePrisma: unsupported operator ${op}`);
    switch (op) {
      case 'equals': if (arg === null ? !isNull : (isNull || !eq(value, arg))) return false; break;
      case 'not':
        if (arg === null) { if (isNull) return false; break; }
        if (isPlainObject(arg)) { if (isNull || matchScalar(value, arg)) return false; break; }
        if (isNull || eq(value, arg)) return false; break;
      case 'in': if (isNull || !arg.some((a) => eq(value, a))) return false; break;
      case 'notIn': if (isNull || arg.some((a) => eq(value, a))) return false; break;
      case 'lt': if (isNull || arg == null || !(cmpValue(value) < cmpValue(arg))) return false; break;
      case 'lte': if (isNull || arg == null || !(cmpValue(value) <= cmpValue(arg))) return false; break;
      case 'gt': if (isNull || arg == null || !(cmpValue(value) > cmpValue(arg))) return false; break;
      case 'gte': if (isNull || arg == null || !(cmpValue(value) >= cmpValue(arg))) return false; break;
      case 'has': if (!Array.isArray(value) || !value.some((x) => eq(x, arg))) return false; break;
      case 'hasSome': if (!Array.isArray(value) || !arg.some((a) => value.some((x) => eq(x, a)))) return false; break;
      case 'hasEvery': if (!Array.isArray(value) || !arg.every((a) => value.some((x) => eq(x, a)))) return false; break;
      case 'isEmpty': if (!Array.isArray(value) || (value.length === 0) !== arg) return false; break;
      default: break;
    }
  }
  return true;
}

export function createFakePrisma(tables) {
  let nextId = 100_000;
  let lastReportAt = 0;
  const newId = () => nextId++;

  const keyOf = {
    swipe: (r) => `${r.swiperId}-${r.swipeeId}`,
    blockedUser: (r) => `${r.blockerId}-${r.blockedId}`,
  };
  const key = (model, row) => (keyOf[model] ? keyOf[model](row) : row.id);
  const rows = (model) => [...(tables[model]?.values() ?? [])];

  // To-one / to-many relations the services read.
  const relations = {
    buddyProfile: {
      filter: { kind: 'one', model: 'buddyFilter', on: (p, f) => f.userId === p.userId },
      photos: { kind: 'many', model: 'buddyPhoto', on: (p, ph) => ph.buddyProfileId === p.id },
    },
    buddyPhoto: {
      buddyProfile: { kind: 'one', model: 'buddyProfile', on: (ph, p) => p.id === ph.buddyProfileId },
    },
    match: {
      messages: { kind: 'many', model: 'chatMessage', on: (m, msg) => msg.matchId === m.id },
    },
  };

  function related(model, row, field) {
    const rel = relations[model]?.[field];
    const found = rows(rel.model).filter((r) => rel.on(row, r));
    return rel.kind === 'one' ? (found[0] ?? null) : found;
  }

  function matchWhere(model, row, where) {
    if (!where) return true;
    for (const [field, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (field === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((w) => matchWhere(model, row, w))) return false;
      } else if (field === 'OR') {
        if (!cond.some((w) => matchWhere(model, row, w))) return false;
      } else if (field === 'NOT') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((w) => matchWhere(model, row, w))) return false;
      } else if (relations[model]?.[field]) {
        const rel = relations[model][field];
        const target = related(model, row, field);
        if (rel.kind !== 'one') throw new Error(`fakePrisma: to-many filter on ${model}.${field} unsupported`);
        if (isPlainObject(cond) && ('is' in cond || 'isNot' in cond)) {
          if ('is' in cond) {
            if (cond.is === null ? target !== null : (target === null || !matchWhere(rel.model, target, cond.is))) return false;
          }
          if ('isNot' in cond) {
            if (cond.isNot === null ? target === null : (target !== null && matchWhere(rel.model, target, cond.isNot))) return false;
          }
        } else if (cond === null) {
          if (target !== null) return false;
        } else if (target === null || !matchWhere(rel.model, target, cond)) {
          return false;
        }
      } else if (!matchScalar(row[field], cond)) {
        return false;
      }
    }
    return true;
  }

  function sortRows(list, orderBy) {
    const order = Array.isArray(orderBy) ? orderBy : (orderBy ? [orderBy] : []);
    const sorted = [...list];
    sorted.sort((a, b) => {
      for (const clause of order) {
        const [field, dir] = Object.entries(clause)[0];
        const rank = ENUM_RANK[field];
        const av = rank ? rank[a[field]] : cmpValue(a[field]);
        const bv = rank ? rank[b[field]] : cmpValue(b[field]);
        if (av === bv) continue;
        // NULLs last ascending, first descending — Postgres' default.
        if (av == null) return dir === 'asc' ? 1 : -1;
        if (bv == null) return dir === 'asc' ? -1 : 1;
        return (av < bv ? -1 : 1) * (dir === 'asc' ? 1 : -1);
      }
      return 0;
    });
    return sorted;
  }

  function shape(model, row, { include, select } = {}) {
    if (!row) return row;
    let out;
    if (select) {
      out = {};
      for (const [f, v] of Object.entries(select)) {
        if (!v) continue;
        out[f] = relations[model]?.[f] ? shapeRelated(model, row, f, v) : row[f];
      }
      return out;
    }
    out = { ...row };
    if (include) {
      for (const [f, v] of Object.entries(include)) {
        if (v) out[f] = shapeRelated(model, row, f, v);
      }
    }
    return out;
  }

  function shapeRelated(model, row, field, spec) {
    const rel = relations[model][field];
    let value = related(model, row, field);
    if (rel.kind === 'many') {
      if (isPlainObject(spec)) {
        if (spec.where) value = value.filter((r) => matchWhere(rel.model, r, spec.where));
        if (spec.orderBy) value = sortRows(value, spec.orderBy);
        if (spec.take != null) value = value.slice(0, spec.take);
      }
      return value.map((r) => shape(rel.model, r, isPlainObject(spec) ? spec : {}));
    }
    return value ? shape(rel.model, value, isPlainObject(spec) ? spec : {}) : null;
  }

  function uniqueLookup(model, where) {
    // Compound unique keys used by the services.
    if (where.swiperId_swipeeId) {
      const { swiperId, swipeeId } = where.swiperId_swipeeId;
      return rows(model).find((r) => r.swiperId === swiperId && r.swipeeId === swipeeId) ?? null;
    }
    if (where.blockerId_blockedId) {
      const { blockerId, blockedId } = where.blockerId_blockedId;
      return rows(model).find((r) => r.blockerId === blockerId && r.blockedId === blockedId) ?? null;
    }
    if (where.userLowId_userHighId) {
      const { userLowId, userHighId } = where.userLowId_userHighId;
      return rows(model).find((r) => r.userLowId === userLowId && r.userHighId === userHighId) ?? null;
    }
    return rows(model).find((r) => matchWhere(model, r, where)) ?? null;
  }

  // Unique constraints that the services rely on surfacing as P2002.
  const uniques = {
    report: [['reporterId', 'reportedUserId']],
    match: [['userLowId', 'userHighId']],
    buddyProfile: [['userId']],
    buddyFilter: [['userId']],
  };
  function assertUnique(model, data, self) {
    for (const cols of uniques[model] ?? []) {
      const clash = rows(model).find((r) => r !== self && cols.every((c) => eq(r[c], data[c])));
      if (clash) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
  }

  const defaults = {
    buddyProfile: () => ({
      bio: null, socialMediaUrl: null, gender: null, dateOfBirth: null, fitnessGoals: [],
      lastSyncedAt: null, isDiscoverable: true, isActive: true, createdAt: new Date(), updatedAt: new Date(),
      moderationHoldAt: null, genderChangedAt: null, genderChangedTo: null, genderChangeClearedAt: null,
      womenOnlyBlocked: false,
    }),
    buddyFilter: () => ({ radiusKm: 25, minAge: 18, maxAge: 60, genders: [], fitnessGoals: [], womenOnly: false }),
    report: () => ({
      details: null, status: 'open', severity: 'normal', reviewedBy: null, reviewedAt: null, resolutionNote: null,
    }),
    match: () => ({ status: 'active', unmatchedBy: null, unmatchedAt: null }),
    chatMessage: () => ({ readAt: null }),
  };

  function insert(model, data) {
    const id = data.id ?? newId();
    const now = new Date();
    const row = { ...(defaults[model]?.() ?? {}), ...data, id };
    if (model === 'match') {
      row.matchedAt = data.matchedAt ?? now;
      row.lastActivityAt = data.lastActivityAt ?? row.matchedAt;
    }
    if (model === 'report') {
      // Monotonic rather than new Date(): rows created in the same tick would
      // otherwise share a timestamp and make "newest first" a coin flip.
      // Strictly increasing (never equal, never behind the previous row) yet
      // still "now", so time-window rules (30-day hold window, held-at-the-
      // time-of-reporting) see a realistic timestamp.
      const at = Math.max(Date.now(), lastReportAt + 1);
      lastReportAt = at;
      row.createdAt = data.createdAt ?? new Date(at);
    }
    if (row.createdAt === undefined) row.createdAt = now;
    assertUnique(model, row, null);
    tables[model].set(key(model, row), row);
    return row;
  }

  function delegate(model) {
    return {
      findUnique: async ({ where, include, select }) => shape(model, uniqueLookup(model, where), { include, select }),
      findFirst: async ({ where, include, select, orderBy } = {}) => {
        const found = sortRows(rows(model).filter((r) => matchWhere(model, r, where)), orderBy)[0] ?? null;
        return shape(model, found, { include, select });
      },
      findMany: async ({ where, include, select, orderBy, take } = {}) => {
        let list = sortRows(rows(model).filter((r) => matchWhere(model, r, where)), orderBy);
        if (take != null) list = list.slice(0, take);
        return list.map((r) => shape(model, r, { include, select }));
      },
      count: async ({ where } = {}) => rows(model).filter((r) => matchWhere(model, r, where)).length,
      create: async ({ data, include, select }) => shape(model, insert(model, data), { include, select }),
      update: async ({ where, data, include, select }) => {
        const row = uniqueLookup(model, where);
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        Object.assign(row, data);
        return shape(model, row, { include, select });
      },
      updateMany: async ({ where, data }) => {
        const hit = rows(model).filter((r) => matchWhere(model, r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      upsert: async ({ where, create, update }) => {
        const row = uniqueLookup(model, where);
        if (row) { Object.assign(row, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))); return { ...row }; }
        return { ...insert(model, create) };
      },
      delete: async ({ where }) => {
        const row = uniqueLookup(model, where);
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        tables[model].delete(key(model, row));
        return row;
      },
      deleteMany: async ({ where } = {}) => {
        const hit = rows(model).filter((r) => matchWhere(model, r, where));
        hit.forEach((r) => tables[model].delete(key(model, r)));
        return { count: hit.length };
      },
    };
  }

  const client = {};
  for (const model of Object.keys(tables)) client[model] = delegate(model);
  client.$transaction = async (arg) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
  client.$queryRaw = async () => [{ '?column?': 1 }];
  return client;
}
