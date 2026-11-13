import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInitials, leaderboardIdentity } from '../utils/leaderboardIdentity.js';

test('toInitials', () => {
  assert.equal(toInitials('Priya Sharma'), 'P.S.');
  assert.equal(toInitials('priya'), 'P.');
  assert.equal(toInitials('  Priya   K  Sharma '), 'P.S.');
  assert.equal(toInitials(''), 'Member');
  assert.equal(toInitials('   '), 'Member');
  assert.equal(toInitials(null), 'Member');
  assert.equal(toInitials(undefined), 'Member');
  assert.equal(toInitials('@@ ##'), 'Member');
});

test('leaderboardIdentity never exposes another user\'s name or photo', () => {
  const other = leaderboardIdentity({ name: 'Priya Sharma', profileImageUrl: 'p.jpg', phone: '999' }, false);
  assert.deepEqual(other, { isMe: false, name: 'P.S.', displayName: 'P.S.', initials: 'P.S.', photoUrl: null });
  const me = leaderboardIdentity({ name: 'Priya Sharma', profileImageUrl: 'p.jpg' }, true);
  assert.equal(me.isMe, true);
  assert.equal(me.name, 'Priya Sharma');
  assert.equal(me.photoUrl, 'p.jpg');
});
