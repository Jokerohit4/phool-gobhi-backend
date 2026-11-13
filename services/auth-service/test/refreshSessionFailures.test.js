import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-access-secret';
let rotationError;
let lookupError;
let user;
let refreshTokenService;
let refreshToken;

test('setup: import the real refresh service and controller with mocked dependencies', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        user = { findUnique: async () => {
          if (lookupError) throw lookupError;
          return user;
        } };
      },
      Prisma: {},
    },
  });
  t.mock.module('../services/refreshTokenService.js', {
    exports: {
      issueRefreshFamily: async () => 'refresh',
      revokeByToken: async () => {},
      rotate: async (_token, { beforeRotate }) => {
        if (rotationError) throw rotationError;
        await beforeRotate(42);
        return { userId: 42, refreshToken: 'rotated-refresh' };
      },
    },
  });
  ({ refreshTokenService } = await import('../services/authService.js'));
  ({ refreshToken } = await import('../controllers/authController.js'));
});

beforeEach(() => {
  rotationError = null;
  lookupError = null;
  user = { id: 42, role: 'customer', type: 'general', isActive: true };
});

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

for (const stage of ['rotation', 'user lookup']) {
  test(`database failure during ${stage} returns retryable 503 instead of logging clients out`, async () => {
    const error = Object.assign(new Error('database unavailable'), { code: 'P1001' });
    if (stage === 'rotation') rotationError = error;
    else lookupError = error;
    const res = response();
    await refreshToken({ body: { token: 'saved-refresh' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.errorCode, 'REFRESH_UNAVAILABLE');
    assert.doesNotMatch(res.body.error, /database unavailable|invalid.*token/i);
  });
}

for (const errorCode of ['E109', 'E120']) {
  test(`real token rejection ${errorCode} still expires the session`, async () => {
    rotationError = { status: 403, error: 'Session rejected', errorCode };
    const res = response();
    await refreshToken({ body: { token: 'invalid-refresh' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.errorCode, errorCode);
  });
}

test('missing refresh token still returns 401', async () => {
  await assert.rejects(refreshTokenService(null), (err) => err.status === 401 && err.errorCode === 'E108');
});

test('deactivated account still returns 403', async () => {
  user.isActive = false;
  await assert.rejects(refreshTokenService('saved-refresh'), (err) => err.status === 403 && err.errorCode === 'E116');
});

test('successful refresh returns the new token pair', async () => {
  const tokens = await refreshTokenService('saved-refresh');
  assert.equal(tokens.refreshToken, 'rotated-refresh');
  assert.equal(typeof tokens.accessToken, 'string');
});
