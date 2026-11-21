import { readFileSync } from 'node:fs';

export const destinations = JSON.parse(readFileSync(new URL('./destinations.json', import.meta.url)));
export const events = {
  app_opened: 'App opened',
  gym_viewed: 'Gym viewed',
  booking_started: 'Booking started',
};
export const cohorts = ['FRIENDS_AND_FAMILY', 'GENERATED_ACCOUNTS', 'TESTING_ACCOUNTS', 'UNKNOWN_USERS'];
export const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
export const isUserId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;
export const isUuid = id => typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);

function string(value, label, max, required = false) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if ((required && !clean) || clean.length > max) throw invalid(label + ' must have ' + (required ? '1 to ' : 'at most ') + max + ' characters');
  return clean;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(label + ' must be between ' + min + ' and ' + max);
  return value;
}

function time(value, label) {
  if (!value) return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid(label + ' must include a date, time and UTC offset');
  }
  return new Date(value).toISOString();
}

export function validateConfig(input) {
  const data = input ?? {};
  const name = string(data.name, 'Campaign name', 100, true);
  const title = string(data.title, 'Title', 80, true);
  const subtitle = string(data.subtitle, 'Subtitle', 220, true);
  const imageUrl = string(data.imageUrl, 'Image URL', 700);
  if (imageUrl) {
    const url = URL.parse(imageUrl);
    if (url?.protocol !== 'https:' || url.username || url.password) throw invalid('Use an HTTPS image URL');
  }
  const deepLink = string(data.deepLink, 'Deep link', 360, true);
  const url = URL.parse(deepLink, 'https://app.invalid');
  const destination = destinations.find(item => item.path === url?.pathname);
  if (!deepLink.startsWith('/') || deepLink.startsWith('//') || url?.origin !== 'https://app.invalid' ||
      deepLink.includes('#') || !destination || url.pathname !== deepLink.split('?')[0]) {
    throw invalid('Choose a supported app destination');
  }
  const parameters = [...url.searchParams.entries()];
  const expected = destination.parameter;
  if (expected) {
    const [[key, value] = []] = parameters;
    const valid = expected === 'runId' ? isUuid(value) : /^\d+$/.test(value) && isUserId(Number(value));
    if (parameters.length !== 1 || key !== expected || !valid) throw invalid('Provide a valid ' + expected + ' for this destination');
  } else if (deepLink.includes('?')) {
    throw invalid('This destination does not take parameters');
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify({ title, subtitle, imageUrl, deepLink }));
  if (payloadBytes + Buffer.byteLength(JSON.stringify({ title, body: subtitle })) > 3600) {
    throw invalid('Push content is too large. Shorten the text or image URL');
  }
  const audience = { type: data.audience?.type };
  switch (audience.type) {
    case 'all': break;
    case 'cohorts':
      if (!Array.isArray(data.audience.cohorts) || !data.audience.cohorts.length ||
          !data.audience.cohorts.every(value => cohorts.includes(value))) throw invalid('Choose at least one valid cohort');
      audience.cohorts = [...new Set(data.audience.cohorts)];
      break;
    case 'users':
      if (!Array.isArray(data.audience.userIds) || !data.audience.userIds.length ||
          data.audience.userIds.length > 1000 || !data.audience.userIds.every(isUserId)) {
        throw invalid('Enter 1 to 1000 valid customer IDs');
      }
      audience.userIds = [...new Set(data.audience.userIds)];
      break;
    default: throw invalid('Choose an audience');
  }

  const mode = data.mode;
  if (!['once', 'recurring', 'event'].includes(mode)) throw invalid('Choose a trigger');
  const startAt = time(data.startAt, 'Start time');
  const endAt = mode === 'once' ? null : time(data.endAt, 'End time');
  if (endAt && startAt && endAt <= startAt) throw invalid('End time must be after the start time');
  const config = { name, title, subtitle, imageUrl, deepLink, audience, mode, startAt, endAt };
  if (mode === 'recurring') {
    config.intervalMinutes = integer(data.intervalMinutes, 'Repeat interval (minutes)', 1, 525600);
    config.maxRuns = integer(data.maxRuns, 'Maximum sends', 2, 1000);
  }
  if (mode === 'event') {
    if (typeof data.event !== 'string' || !Object.hasOwn(events, data.event)) throw invalid('Choose a supported event');
    config.event = data.event;
    config.delayMinutes = integer(data.delayMinutes, 'Delay (minutes)', 0, 43200);
    config.cooldownMinutes = integer(data.cooldownMinutes, 'Cooldown (minutes)', 1, 43200);
    config.maxPerUser = integer(data.maxPerUser, 'Maximum sends per customer', 1, 100);
  }
  return config;
}

export function nextSlot(config, from, now, runCount) {
  if (config.mode !== 'recurring' || runCount >= config.maxRuns) return null;
  const interval = config.intervalMinutes * 60_000;
  const periods = Math.max(1, Math.floor((now - from) / interval) + 1);
  const next = new Date(+from + periods * interval);
  return config.endAt && next > new Date(config.endAt) ? null : next;
}
