import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortName } from '../utils/displayName.js';

test('first name and the initial of the last', () => {
  assert.equal(shortName('Rohit Singh'), 'Rohit S.');
  assert.equal(shortName('  rohit   singh  '), 'rohit S.');
});

test('with several names, the last is the surname', () => {
  assert.equal(shortName('Anna Maria de Souza'), 'Anna S.');
});

test('a single name is shown as it is', () => {
  assert.equal(shortName('Madonna'), 'Madonna');
});

test('a trailing token with no letter is not a surname', () => {
  assert.equal(shortName('Buddy 2'), 'Buddy');
});

test('non-latin names get a proper initial', () => {
  assert.equal(shortName('अनन्या शर्मा'), 'अनन्या श.');
  assert.equal(shortName('Émile élan'), 'Émile É.');
});

test('nothing becomes Buddy', () => {
  for (const blank of [null, undefined, '', '   ']) assert.equal(shortName(blank), 'Buddy');
});

test('the surname never survives', () => {
  assert.ok(!shortName('Rohit Singh').includes('ingh'));
});
