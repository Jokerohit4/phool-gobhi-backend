import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customizeFood, compositionForFood, dietaryTypeOf, normaliseIngredients,
  assertSpecificName } from '../services/ledger/foodComposition.js';
import { FOODS } from '../prisma/seed/foods.seed.js';

const base = { id: 1, name: 'Aloo burger', dietaryType: 'veg', createdByUserId: null,
  kcal: 200, proteinG: 5, carbsG: 30, fatG: 7, fibreG: 3,
  ironMg: 2, magnesiumMg: 20, calciumMg: 30, zincMg: 1, verified: true };
const egg = { ...base, id: 2, name: 'Egg, boiled', dietaryType: 'egg', kcal: 150,
  proteinG: 13, carbsG: 1, fatG: 10, fibreG: 0, zincMg: null };
function database(rows = [base, egg]) {
  const created = [];
  const tx = { foodItem: {
    async findMany({ where }) {
      assert.ok(where.OR.some((part) => part.createdByUserId === null));
      const owner = where.OR.find((part) => part.createdByUserId !== null).createdByUserId;
      return rows.filter((r) => where.id.in.includes(r.id) && (r.createdByUserId == null || r.createdByUserId === owner));
    },
    async create({ data }) { const food = { id: 100 + created.length, ...data }; created.push(food); return food; },
    async update() { assert.fail('a personal recipe must never update a catalogue row'); },
  } };
  return { created, foodItem: tx.foodItem, $transaction: async (work) => work(tx) };
}

test('every starter food has classification and a normalized ingredient division', () => {
  for (const food of FOODS) {
    const profile = compositionForFood(food);
    assert.ok(['veg', 'egg', 'non_veg', 'unknown'].includes(profile.dietaryType), food.name);
    assert.ok(profile.ingredients.length > 0, food.name);
    assert.ok(Math.abs(profile.ingredients.reduce((sum, i) => sum + i.grams, 0) - 100) < 0.01, food.name);
  }
  for (const name of ['Aloo burger', 'Chicken burger', 'Egg burger', 'Paneer burger']) {
    assert.ok(FOODS.some((f) => f.name === name));
  }
  assert.equal(dietaryTypeOf(FOODS.find((f) => f.name === 'Egg burger')), 'egg');
  for (const name of ['Bread, white', 'Biscuit, packaged', 'Mayonnaise, egg', 'Tomato ketchup']) {
    assert.ok(compositionForFood(FOODS.find((f) => f.name === name)).ingredients.length > 1, name);
  }
});

test('an added egg makes a private recipe and recomputes macros without changing the base', async () => {
  const db = database();
  const before = structuredClone(base);
  const result = await customizeFood(db, { userId: 7, foodItemId: 1, baseGrams: 100,
    additions: [{ foodItemId: 2, grams: 50 }], name: 'Aloo burger with egg' });
  assert.equal(result.createdByUserId, 7);
  assert.equal(result.baseFoodItemId, 1);
  assert.equal(result.dietaryType, 'egg');
  assert.equal(result.nonVeg, true);
  assert.equal(result.veg, false);
  assert.equal(result.verified, false);
  assert.equal(result.servings[0].grams, 150);
  assert.equal(result.kcal, 183.33);
  assert.equal(result.proteinG, 7.67);
  assert.equal(result.zincMg, null, 'missing nutrient information must not become zero');
  assert.ok(result.ingredients.some((i) => /Egg/.test(i.name)));
  assert.deepEqual(base, before);
});

test('another user cannot use a private food as the base or an ingredient', async () => {
  const privateFood = { ...egg, id: 9, createdByUserId: 7 };
  for (const input of [
    { foodItemId: 9, additions: [{ foodItemId: 1, grams: 20 }] },
    { foodItemId: 1, additions: [{ foodItemId: 9, grams: 20 }] },
  ]) {
    const db = database([base, privateFood]);
    await assert.rejects(customizeFood(db, { userId: 8, baseGrams: 100, ...input }), { status: 404 });
    assert.equal(db.created.length, 0);
  }
});

test('an added composite ingredient keeps its name and catalogue reference', async () => {
  const cheese = { ...base, id: 3, name: 'Cheese, processed slice',
    ingredients: [{ name: 'Milk curds', grams: 97, dietaryType: 'veg' },
      { name: 'Salt and culture', grams: 3, dietaryType: 'veg' }] };
  const result = await customizeFood(database([base, cheese]), {
    userId: 7, foodItemId: 1, baseGrams: 100, additions: [{ foodItemId: 3, grams: 25 }],
  });
  const added = result.ingredients.find((i) => i.foodItemId === 3);
  assert.equal(added.name, 'Cheese, processed slice');
  assert.equal(added.grams, 20);
  assert.match(result.searchText, /cheese/);
});

test('meat overrides egg and veg, while an unknown ingredient cannot claim veg', () => {
  assert.equal(dietaryTypeOf({ ingredients: [{ dietaryType: 'veg' }, { dietaryType: 'egg' }] }), 'egg');
  assert.equal(dietaryTypeOf({ ingredients: [{ dietaryType: 'egg' }, { dietaryType: 'non_veg' }] }), 'non_veg');
  assert.equal(dietaryTypeOf({ ingredients: [{ dietaryType: 'veg' }, { dietaryType: 'unknown' }] }), 'unknown');
});

test('generic names, invalid amounts and malformed recipes are refused', async () => {
  assert.throws(() => assertSpecificName(' burger '), /variant/);
  assert.deepEqual(normaliseIngredients([{ name: 'Oil', grams: -1 }]), []);
  for (const grams of [-1, 0, Infinity, 6000]) {
    await assert.rejects(customizeFood(database(), { userId: 7, foodItemId: 1,
      baseGrams: 100, additions: [{ foodItemId: 2, grams }] }), { status: 400 });
  }
});


test('removing an original referenced egg recomputes a private veggie recipe and portion', async () => {
  const recipe = {...base,id:10,name:'Egg burger',dietaryType:'egg',kcal:175,proteinG:9,carbsG:15.5,fatG:8.5,fibreG:1.5,
    ingredients:[{foodItemId:2,name:'Egg',grams:50,dietaryType:'egg'}, {foodItemId:1,name:'Vegetable filling',grams:50,dietaryType:'veg'}]};
  const before=structuredClone(recipe);const db=database([base,egg,recipe]);
  const result=await customizeFood(db,{userId:7,foodItemId:10,baseGrams:100,removals:[{index:0,name:'Egg'}]},
    {estimateNutrition:async()=>assert.fail('catalogue references suffice')});
  assert.equal(result.kcal,200);assert.equal(result.proteinG,5);assert.equal(result.servings[0].grams,50);
  assert.equal(result.dietaryType,'veg');assert.equal(dietaryTypeOf(result),'veg');assert.equal(compositionForFood(result).dietaryType,'veg');
  assert.equal(result.ingredients.length,1);assert.equal(result.ingredients[0].name,'Vegetable filling');
  assert.equal(result.createdByUserId,7);assert.equal(result.verified,false);assert.equal(result.zincMg,null);
  assert.deepEqual(recipe,before);
});

test('unreferenced removals use validated remaining-recipe estimates, never unchanged nutrition', async () => {
  const db=database();let remaining;
  const result=await customizeFood(db,{userId:7,foodItemId:1,baseGrams:100,removals:[{index:4,name:'Onion'}]},
    {estimateNutrition:async(_db,userId,ingredients)=>{assert.equal(userId,7);remaining=ingredients;return {
      kcal:185,proteinG:5,carbsG:28,fatG:6,fibreG:2.5,servings:[{label:'portion',grams:95}],
    };}});
  assert.equal(result.kcal,185);assert.equal(result.servings[0].grams,95);
  assert.ok(!remaining.some(i=>i.name==='Onion'));
  assert.ok(Math.abs(remaining.reduce((sum,i)=>sum+i.grams,0)-100)<.01);
  assert.equal(result.ironMg,null);
});

test('removal estimates fail explicitly without inserting a misleading food', async () => {
  const db=database();
  await assert.rejects(customizeFood(db,{userId:7,foodItemId:1,baseGrams:100,removals:[{index:4,name:'Onion'}]},
    {estimateNutrition:async()=>({kcal:0})}),{status:502});
  assert.equal(db.created.length,0);
});

test('all originals may be replaced, but an empty recipe and stale removals are refused', async () => {
  const simple={...base,ingredients:[{name:'Filling',grams:100,dietaryType:'veg'}]};
  const input={userId:7,foodItemId:1,baseGrams:100,removals:[{index:0,name:'Filling'}]};
  await assert.rejects(customizeFood(database([simple,egg]),input),{status:400});
  const result=await customizeFood(database([simple,egg]),{...input,additions:[{foodItemId:2,grams:30}]});
  assert.equal(result.kcal,150);assert.equal(result.servings[0].grams,30);assert.equal(result.dietaryType,'egg');
  for (const removals of [[{index:4,name:'Wrong name'}],[{index:-1,name:'Onion'}],[{index:4,name:'Onion'},{index:4,name:'Onion'}]]) {
    await assert.rejects(customizeFood(database(),{userId:7,foodItemId:1,baseGrams:100,removals}),{status:409});
  }
});

test('paid recipe estimation has a per-user hourly budget', async () => {
  const db=database();db.foodPhotoUsage={count:async()=>20};
  await assert.rejects(customizeFood(db,{userId:7,foodItemId:1,baseGrams:100,removals:[{index:4,name:'Onion'}]}),{status:429});
  assert.equal(db.created.length,0);
});
