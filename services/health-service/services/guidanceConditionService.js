import prisma from '../db/prisma.js';

export const conditionView = profile => ({
  hasCondition: profile?.hasCondition ?? null,
  conditionType: profile?.conditionType ?? null,
  conditionSource: profile?.conditionSource ?? null,
  conditionDeclaredAt: profile?.conditionDeclaredAt ?? null,
  region: profile?.region ?? null,
});

const isConditionType = value => ['diabetes', 'prediabetes'].includes(value);
const invalid = message => Object.assign(new Error(message), { status: 400 });

export function conditionAnswer({ hasCondition, conditionType = null } = {}) {
  if (typeof hasCondition !== 'boolean') throw invalid('Answer whether you have a health condition.');
  if (conditionType !== null && (!hasCondition || !isConditionType(conditionType))) {
    throw invalid('Choose diabetes or prediabetes only when you answer yes.');
  }
  return { hasCondition, conditionType };
}

export function checkoutCondition({ region, statedCondition } = {}) {
  if (!['GURUGRAM', 'REST_INDIA'].includes(region)) throw invalid('Choose a valid coaching region.');
  if (statedCondition === undefined) return { region };
  if (!isConditionType(statedCondition)) throw invalid('Choose diabetes or prediabetes');
  return { region, answer: { hasCondition: true, conditionType: statedCondition } };
}

// Serialize report and answer writes, including when the user has no profile row yet.
export function lockGuidanceCondition(tx, userId) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guidance-condition:${userId}`}, 0))`;
}

export async function recordReportCondition(tx, userId) {
  const where = { userId };
  const profile = await tx.guidanceProfile.findUnique({ where });
  if (profile?.hasCondition === true) return profile;
  const data = { hasCondition: true, conditionType: null, conditionSource: 'report', conditionDeclaredAt: new Date() };
  return tx.guidanceProfile.upsert({ where, create: { userId, ...data }, update: data });
}

export async function saveGuidanceCondition(userId, { answer, region, staff = false }) {
  return prisma.$transaction(async tx => {
    await lockGuidanceCondition(tx, userId);
    const where = { userId };
    const current = await tx.guidanceProfile.findUnique({ where });
    const data = {};
    if (region !== undefined && region !== current?.region) data.region = region;
    if (answer) {
      const locked = current?.hasCondition === true && current.conditionSource === 'report';
      const changed = answer.hasCondition !== current?.hasCondition || answer.conditionType !== current?.conditionType;
      if (locked && !staff && changed) {
        throw Object.assign(new Error('Your report set this answer. Contact support to change it.'), { status: 409 });
      }
      if (changed || (!staff && !locked && current?.conditionSource !== 'self_declared')) {
        Object.assign(data, answer, {
          conditionSource: staff ? (answer.hasCondition ? current?.conditionSource ?? null : null) : 'self_declared',
          conditionDeclaredAt: new Date(),
        });
      }
    }
    if (!Object.keys(data).length) return conditionView(current);
    return conditionView(await tx.guidanceProfile.upsert({ where, create: { userId, ...data }, update: data }));
  });
}
