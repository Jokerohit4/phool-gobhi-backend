import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Separate processes exercise the actual host timezone, including DST rules.
for (const timezone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
  test(`journey calendar weeks and referral spans in ${timezone}`, () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { mock } from 'node:test';
        import { countSteadyWeeks, getSteadyWeeksDetail } from './services/journey/steadyWeeks.js';

        const days = ['2026-10-19', '2026-10-18', '2026-10-13', '2026-10-12', '2026-10-12'];
        assert.equal(countSteadyWeeks(days), 1);
        assert.deepEqual(getSteadyWeeksDetail(days), [{
          weekStart: '2026-10-12',
          days: ['2026-10-12', '2026-10-13', '2026-10-18'],
          dayCount: 3,
        }]);
        assert.deepEqual(getSteadyWeeksDetail(['2026-01-01', '2025-12-29']), [{
          weekStart: '2025-12-29', days: ['2025-12-29', '2026-01-01'], dayCount: 2,
        }]);

        mock.module('@prisma/client', { namedExports: { PrismaClient: class {} } });
        mock.module(new URL('./utils/fetchInternal.js', import.meta.url).href, {
          namedExports: { fetchInternal: async (_base, path) => ({ data:
            path.includes('/devices/') ? { userIds: [7] } : {
              referredByUserId: 3, createdAt: '2025-01-01T00:00:00Z', installIds: ['device'],
            },
          }) },
        });
        process.env.WALLET_SERVICE_URL = 'https://wallet.invalid';
        const credits = [];
        globalThis.fetch = async (url, options) => {
          credits.push(JSON.parse(options.body));
          return { ok: true, json: async () => ({}) };
        };
        const { checkAndTriggerHomeDaysReferral } = await import('./services/journey/referralHomeTrigger.js');
        // Seven inclusive dates straddle the spring DST transition (143 elapsed hours).
        await checkAndTriggerHomeDaysReferral(7, ['2026-03-11', '2026-03-08', '2026-03-05'], {});
        assert.deepEqual(credits, [{ referrerId: 3, friendId: 7, trigger: 'home_days' }]);
        await checkAndTriggerHomeDaysReferral(7, ['2026-03-10', '2026-03-08', '2026-03-05'], {});
        assert.equal(credits.length, 1, 'six calendar days must not qualify');
      `,
    ], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
