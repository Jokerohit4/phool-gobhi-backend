// Newest BiometricEntry per metric, without reading the user's whole history.
//
// The old shape was `findMany({ where: { userId }, orderBy: localDate desc })`
// and "first row per metric wins" in JS, which pulls every reading a user has
// ever logged (a year of daily weigh-ins plus lab results) to keep ~a dozen rows.
//
// Here: one grouped pass over the (userId, metric, localDate) index for each
// metric's newest day, then one indexed fetch of exactly those rows. The
// (userId, metric, localDate) triple is unique, so each pair names one row, which
// is the same row "first per metric over localDate desc" selected.
//
// Rows come back ordered localDate desc, createdAt desc (the old sort), so any
// caller that iterates them sees the order it used to.
export async function latestBiometricRows(prisma, userId, { select } = {}) {
  const newest = await prisma.biometricEntry.groupBy({
    by: ['metric'],
    where: { userId },
    _max: { localDate: true },
  });
  const pairs = newest.filter((g) => g._max?.localDate != null);
  if (!pairs.length) return [];
  const rows = await prisma.biometricEntry.findMany({
    where: { userId, OR: pairs.map((g) => ({ metric: g.metric, localDate: g._max.localDate })) },
    ...(select ? { select: { ...select, metric: true, localDate: true, createdAt: true } } : {}),
  });
  return rows.sort((a, b) => {
    if (a.localDate !== b.localDate) return a.localDate < b.localDate ? 1 : -1;
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
}
