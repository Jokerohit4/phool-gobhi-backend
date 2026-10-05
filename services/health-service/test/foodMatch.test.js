import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchText,
  matchToCatalogue,
  MIN_MATCH_SCORE,
  rankFoods,
  scoreMatch,
} from '../services/ledger/foodMatch.js';

// This module is the ranking that decides which row a search or a photo lands
// on, and both of those write the row's numbers into somebody's health ledger.
// A regression here does not crash - it silently logs the wrong dish, which is
// the failure nobody notices for six weeks.
//
// The tests are therefore about ORDER and about the boundary cases, not about
// the function returning a truthy value. "rice" returning *a* row is not the
// requirement; "rice" returning plain rice rather than biryani is.

const row = (name, aliases = []) => ({ id: name, name, aliases });

// --- buildSearchText --------------------------------------------------------

test('buildSearchText folds the name and every alias into one lowercased haystack', () => {
  assert.equal(buildSearchText('Omelette, cooked', ['Omelette', 'omelet']), 'omelette, cooked omelette omelet');
});

test('buildSearchText survives a missing name and a null alias list', () => {
  // The seeder writes this for every row, including ones a user added by hand
  // with no aliases at all. Throwing here fails a seed half way through.
  assert.equal(buildSearchText('Water', null), 'water');
  assert.equal(buildSearchText('Water', ['', null, undefined]), 'water');
  assert.equal(buildSearchText(null, ['chai']), 'chai');
});

test('buildSearchText collapses the whitespace a name can carry', () => {
  // Trimming each part is what keeps "masala  dosa" from producing a haystack
  // with a double space in the middle, which `contains` would then fail to
  // match for a query that spells it with one.
  assert.equal(buildSearchText('  Masala Dosa  ', [' plain ']), 'masala dosa plain');
});

// --- scoreMatch: tiers ------------------------------------------------------

test('an exact name beats an exact alias', () => {
  const A = row('Dosa', ['masala dosa']);
  const B = row('Masala dosa', []);
  assert.ok(scoreMatch(A, 'dosa') > scoreMatch(B, 'dosa'));
});

test('an exact alias beats a prefix match on a longer name', () => {
  // The case that used to send people to biryani: "rice" is an alias of the
  // plain row and merely a substring of half a dozen others.
  assert.ok(scoreMatch(row('Rice, cooked', ['rice']), 'rice') > scoreMatch(row('Fried rice balls', []), 'rice'));
});

test('a prefix match beats a substring match', () => {
  assert.ok(scoreMatch(row('Idli, steamed'), 'idli') > scoreMatch(row('Vegetable idli', []), 'idli'));
});

test('a name substring beats an alias substring', () => {
  assert.ok(
    scoreMatch(row('Poha, cooked', ['something else']), 'poha') >
      scoreMatch(row('Breakfast', ['poha special']), 'poha'),
  );
});

test('within a tier the SHORTEST name wins', () => {
  // The reason the deduction exists: "rice" should reach the general row before
  // it reaches a dish that happens to contain the word.
  const short = row('Rice, cooked', ['rice']);
  const long = row('Rice with basmati and fried onion', []);
  assert.ok(scoreMatch(short, 'rice') > scoreMatch(long, 'rice'));
});

test('matching ignores case on both sides', () => {
  assert.equal(scoreMatch(row('Paneer Tikka'), 'PANEER tikka'), 1000);
  assert.ok(scoreMatch(row('Paneer Tikka', ['PANEER']), 'paneer') > 0);
});

test('surrounding whitespace in the query does not lose the match', () => {
  // The client passes whatever the user typed. Trimming here rather than relying
  // on the controller is what makes "omelette " and "omelette" the same query,
  // which matters because the request flow compares the two against each other.
  const padded = scoreMatch(row('Palak paneer', ['shak paneer']), '  shak paneer  ');
  const trimmed = scoreMatch(row('Palak paneer', ['shak paneer']), 'shak paneer');
  assert.ok(padded > 0);
  assert.equal(padded, trimmed);
});

// --- scoreMatch: the two-character rule -------------------------------------

test('a two-character query scores 0 against a substring but still an exact match', () => {
  // Exact must survive: "id" is not a food, but a two-letter food that somebody
  // named exactly is a real row.
  assert.equal(scoreMatch(row('Dalia, cooked'), 'da'), 0);
  assert.equal(scoreMatch(row('Dal'), 'dal'), 1000);
});

test('a one-character query only ever matches exactly', () => {
  assert.equal(scoreMatch(row('Rice'), 'r'), 0);
  assert.equal(scoreMatch(row('r'), 'r'), 1000);
});

test('an empty query scores 0 rather than throwing', () => {
  assert.equal(scoreMatch(row('Rice'), ''), 0);
  assert.equal(scoreMatch(row('Rice'), '   '), 0);
  assert.equal(scoreMatch(row('Rice'), null), 0);
});

test('a row with no aliases at all is still matchable by name', () => {
  // User-created foods are the common no-alias case, and a crash here would
  // make search throw on exactly the rows the picker most needs to show.
  assert.ok(scoreMatch({ name: 'Grandma\'s stew' }, 'grandma') > 0);
  assert.ok(scoreMatch({ name: 'Grandma\'s stew' }, 'stew') > 0);
});

// --- MIN_MATCH_SCORE --------------------------------------------------------

test('an alias-substring match clears the photo floor even against a long name', () => {
  // The floor is TIER_ALIAS_SUBSTRING minus the maximum length deduction, not
  // the tier value. Set to the tier value it would reject every alias match
  // against a name longer than a few characters while accepting it against a
  // short one - the photo path behaving differently purely on name length.
  const long = row('Shak paneer, cooked', ['palak paneer masala']);
  const score = scoreMatch(long, 'paneer masala');
  assert.ok(score < 300, `expected the deduction to pull it below the tier, got ${score}`);
  assert.ok(score >= MIN_MATCH_SCORE, `and to still clear the floor, got ${score} vs ${MIN_MATCH_SCORE}`);
  assert.equal(matchToCatalogue([long], 'paneer masala'), long);
});

test('the length deduction cannot drop a row into the tier below', () => {
  // The deduction is capped at 99 and the tiers are 100 apart, which is the
  // whole reason for both numbers. Without either, a 300-character name would
  // lose a comparison to a short one on name length alone.
  const absurd = row('P'.repeat(300));
  assert.ok(scoreMatch(absurd, 'ppp') > 800, 'a prefix match must stay above the alias-exact tier');

  const alias = row('Curd, cooked', ['shrikhand with rabri']);
  assert.ok(scoreMatch(alias, 'rabri') > MIN_MATCH_SCORE);
});

// --- rankFoods --------------------------------------------------------------

const CATALOGUE = [
  row('Biryani, chicken', ['biryani']),
  row('Fried rice balls', ['rice', 'fried rice']),
  row('Vegetable biryani', ['biryani']),
  row('Rice, cooked', ['rice', 'chawal']),
  row('Curd rice', ['rice']),
];

test('rankFoods puts the plain row above every dish that merely contains it', () => {
  // The regression this whole module exists to prevent: searching "rice" and
  // having "Curd rice" or "Fried rice balls" at the top, because those also
  // carry "rice" as an alias and an alphabetical fallback cannot tell the user
  // which one they meant.
  const out = rankFoods(CATALOGUE, 'rice');
  assert.equal(out[0].name, 'Rice, cooked');
  assert.ok(out.length >= 3);
});

test('rankFoods puts a row whose NAME starts with the query above one matched by alias', () => {
  // Same requirement from the other direction, and the reason the alias-exact
  // check runs after the prefix check: both rows match "rice" exactly, so
  // without ordering them by where the query sits in the name, the tie falls to
  // alphabetical and "Curd rice" wins.
  const out = rankFoods([row('Curd rice', ['rice']), row('Rice, cooked', ['rice'])], 'rice');
  assert.deepEqual(out.map((f) => f.name), ['Rice, cooked', 'Curd rice']);
});

test('a query inside a word is not a match, and this one was live', () => {
  // Found by running the real seeded catalogue, not by reading the code: "tea"
  // returned "Momos, steamed" in third place, because s-T E A-m-e-d contains
  // "tea". Every unit test passed while that was happening, because none of
  // them had a row containing the word "steamed".
  assert.equal(scoreMatch(row('Momos, steamed', ['momos', 'steamed momos']), 'tea'), 0);
  assert.deepEqual(rankFoods([row('Momos, steamed'), row('Green tea'), row('Tea with milk and sugar')], 'tea'), [
    row('Tea with milk and sugar'),
    row('Green tea'),
  ]);
});

test('a word-start match still counts when an earlier occurrence is inside a word', () => {
  // "steamed tea" has "tea" at index 1 (mid-word, not a match) and index 8 (a
  // real word). Taking the first occurrence only would drop this row, which is
  // the failure mode of implementing this with a single indexOf or a lookbehind
  // anchored at the start of the string.
  assert.ok(scoreMatch(row('Steamed tea, plain', []), 'tea') > 0);
  assert.equal(scoreMatch(row('Steamed momos', []), 'tea'), 0);
});

test('partial typing still reaches the rest of the word', () => {
  // The reason only the START of a match is boundary-checked. An end-of-word
  // check would reject "ric" against "Rice, cooked", which is the single most
  // common thing anybody does in a food search box.
  assert.ok(scoreMatch(row('Rice, cooked', []), 'ric') > 0);
  assert.ok(scoreMatch(row('Rice, cooked', []), 'rice, cook') > 0);
  // ...but the other half of the rule still bites: the query has to start a word.
  assert.equal(scoreMatch(row('Rice, cooked', []), 'ice'), 0);
});

test('the word-start rule treats a non-ASCII letter as part of a word', () => {
  // If the boundary test were [a-z] rather than a Unicode letter class, the
  // accented 'è' would read as a separator and "me" would match "Crème" - the
  // same false positive as "tea" in "steamed", just spelled with a diacritic.
  assert.equal(scoreMatch(row('Crème brûlée', []), 'me'), 0);
  assert.equal(scoreMatch(row('Crème brûlée', []), 'ème'), 0);
  assert.ok(scoreMatch(row('Crème brûlée', []), 'crème') > 0);
  assert.ok(scoreMatch(row('Crème brûlée', []), 'brûlée') > 0);
});

test('rankFoods drops rows that only matched across a field boundary', () => {
  // "cooked chawal" appears in the haystack - name then alias, space separated -
  // so SQL returns the row, but it is not a substring of the name or of any
  // single alias. rankFoods is where that gets dropped rather than in the
  // picker, because the picker cannot tell a real match from a boundary
  // artefact and would just show it.
  const out = rankFoods([row('Rice, cooked', ['chawal'])], 'cooked chawal');
  assert.deepEqual(out, []);
  // And the two halves of that query each still find the row, which is what
  // makes dropping the boundary match the right call rather than a loss.
  assert.equal(rankFoods([row('Rice, cooked', ['chawal'])], 'cooked').length, 1);
  assert.equal(rankFoods([row('Rice, cooked', ['chawal'])], 'chawal').length, 1);
});

test('rankFoods is stable for equal scores', () => {
  // Alphabetical tiebreak, so the list does not reshuffle between keystrokes
  // as the candidate set changes.
  const out = rankFoods(CATALOGUE, 'biryani');
  assert.deepEqual(out.map((f) => f.name), ['Biryani, chicken', 'Vegetable biryani']);
});

test('rankFoods returns nothing for an empty query rather than everything', () => {
  assert.deepEqual(rankFoods(CATALOGUE, ''), []);
  assert.deepEqual(rankFoods(CATALOGUE, null), []);
});

// --- matchToCatalogue -------------------------------------------------------

test('matchToCatalogue returns the single best row, not all of them', () => {
  assert.equal(matchToCatalogue(CATALOGUE, 'rice').name, 'Rice, cooked');
  assert.equal(matchToCatalogue(CATALOGUE, 'biryani').name, 'Biryani, chicken');
});

test('matchToCatalogue returns null when nothing is close enough', () => {
  // null is the honest answer, and the photo path's whole point: a wrong food in
  // the ledger is worse than a name the user has to correct themselves.
  assert.equal(matchToCatalogue(CATALOGUE, 'xyzzy'), null);
  assert.equal(matchToCatalogue([], 'rice'), null);
});

test('matchToCatalogue accepts a partial name, which is what a photo produces', () => {
  // The original caller: a vision model proposing "paneer curry" for a plate of
  // palak paneer. The threshold must not be so tight that it rejects the match
  // it exists to make - the alternative is the user correcting every line by
  // hand, which is the outcome this whole path was built to avoid.
  assert.ok(matchToCatalogue([row('Palak paneer, cooked', ['palak paneer'])], 'paneer'));
  assert.ok(matchToCatalogue([row('Chicken biryani', ['biryani'])], 'biryani'));
});