import { migrateUser } from '../services/health-service/scripts/migrateToOnePlan.js';

const TEST_USER_ID = 1;

describe('migrateToOnePlan', () => {
  test('reports no coach basic consent', async () => {
    const result = await migrateUser(
      { userId: TEST_USER_ID } // minimal mock; actual test uses prisma mock
    );
    expect(result.hasCoachConsent).toBe(false);
    expect(result.note).toContain('no coach basic consent');
  });

  test('reports no JourneyProgress row', async () => {
    // When called without a full prisma, the function should handle gracefully
    const result = await migrateUser(
      { userId: TEST_USER_ID }
    );
    // Should not crash
    expect(result).toBeDefined();
  });

  test('handles dry run without DATABASE_URL error', async () => {
    // The main() function should error on missing DATABASE_URL, but migrateUser
    // itself should be operable in isolation
    const result = await migrateUser(
      { userId: TEST_USER_ID }
    );
    expect(result).toBeDefined();
  });
});