import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeatures, FEATURE_FLAGS } from '../config/featureFlagRegistry.js';
test('weeklySummary is on only for explicit dev, off for prod/unknown', () => {
  const oldEnv=process.env.APP_ENV, oldService=process.env.K_SERVICE;
  try {
    for(const [env,service,expected] of [['prod','auth-service-prod',false],['dev','auth-service-dev',true],['','auth-service-dev',true],['','',false]]) {
      process.env.APP_ENV=env;process.env.K_SERVICE=service;
      assert.equal(defaultFeatures().weeklySummary.enabled,expected);
    }
    assert.deepEqual(FEATURE_FLAGS.find(f=>f.name==='weeklySummary').deps,['coachJourney']);
  } finally {
    if(oldEnv===undefined)delete process.env.APP_ENV;else process.env.APP_ENV=oldEnv;
    if(oldService===undefined)delete process.env.K_SERVICE;else process.env.K_SERVICE=oldService;
  }
});
