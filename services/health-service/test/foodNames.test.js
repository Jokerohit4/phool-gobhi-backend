import {test} from 'node:test';
import assert from 'node:assert/strict';
import {foodQueryTerms,canonicalFoodName} from '../services/ledger/foodNames.js';
import {searchFoods} from '../services/ledger/nutritionService.js';
test('Hinglish and Hindi clove aliases resolve without changing longer dish names',()=>{
 assert.equal(canonicalFoodName(' LAUNG '),'clove');assert.equal(canonicalFoodName('\u0932\u094c\u0902\u0917'),'clove');
 assert.ok(foodQueryTerms('cloves').includes('laung'));assert.equal(canonicalFoodName('laung rice'),'laung rice');
});
test('database alias expansion retains ownership and deduplicates the same clove',async()=>{
 const clove={id:1,name:'Clove',aliases:[],createdByUserId:null};let filters;
 const db={foodItem:{findMany:async({where})=>{filters=where;return [clove,{id:2,name:'Garlic',aliases:['garlic cloves'],createdByUserId:null}];}}};
 const found=await searchFoods(db,7,{query:'laung',includeUnverified:true});
 assert.deepEqual(found,[clove]);assert.ok(filters.OR.some(x=>x.name?.contains==='clove'));
 assert.deepEqual(filters.AND[0],{OR:[{createdByUserId:null},{createdByUserId:7}]});
});
