// The push a person gets when a report they confirmed lands in a bucket that
// needs a closer look. Pure so the rule is pinned without Firebase or a DB.
//
// A notification is drawn by the OS on a lock screen, so the copy names no
// test, no value and no condition - only that there is something to open
// (same rule as the nudges: no health detail in a push payload).

const NOTICE = {
  AMBER: {
    title: 'Your report has been read',
    body: 'A few results are worth a closer look. Open the app to see what to do next.',
  },
  RED: {
    title: 'Your report needs a closer look',
    body: 'Some results should be reviewed before you start guided exercise. Open the app to see the next step.',
  },
};

const SEVERITY = { GREEN: 0, AMBER: 1, RED: 2 };

// Notify only when the bucket is AMBER or RED and is new or worse than the
// last confirmed one. Re-confirming the same report, or a report that lowers
// the risk, sends nothing: a repeat alert for what they already know teaches
// people to swipe them away.
export function riskNoticeFor(previousBucket, nextBucket) {
  const next = SEVERITY[nextBucket];
  if (!next) return null;
  const previous = SEVERITY[previousBucket] ?? -1;
  if (next <= previous) return null;
  return { ...NOTICE[nextBucket], data: { type: 'report_risk' } };
}
