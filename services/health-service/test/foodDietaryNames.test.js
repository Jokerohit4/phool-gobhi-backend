import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dietaryTypeOf } from '../services/ledger/foodComposition.js';

// A name that states the ABSENCE of egg must not make a food egg. INDB has
// "Mayonnaise without eggs" and "Vegetarian egg kofta curry"; both are veg.
test('names that say "without egg", "egg-less" or "vegetarian egg" are not egg by name', () => {
  for (const name of ['Mayonnaise without eggs', 'Vanilla ice cream without egg', 'Egg-less cake', 'No egg cake', 'Vegetarian egg kofta curry']) {
    assert.equal(dietaryTypeOf({ name, dietaryType: 'veg' }), 'veg', name);
  }
  for (const name of ['Egg curry', 'Boiled egg', 'Scotch egg', 'Masala omelette']) {
    assert.equal(dietaryTypeOf({ name, dietaryType: 'veg' }), 'egg', name);
  }
  assert.equal(dietaryTypeOf({ name: 'Baingan / eggplant', dietaryType: 'veg' }), 'veg');
});
