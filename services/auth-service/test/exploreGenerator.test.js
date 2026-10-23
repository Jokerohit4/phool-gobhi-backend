import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cell, round6, pick, clock, generate } from '../exploration/generator.js';
import { catalogueV1 } from '../exploration/contracts.js';

// Deliberately read the shared frozen fixture by absolute path, rather than a copied test oracle.
const path='C:/Users/rohit/Phool-Gobhi/wt/explore-world/docs/explore-contracts/generator-v1-fixtures.json';
const fixture=JSON.parse(readFileSync(path,'utf8'));
assert.equal(fixture.catalogueHash,catalogueV1.contentHash);
for (const c of fixture.cases) test(`generator v1: ${c.id}`,()=>{
  let actual;
  if (c.kind==='generate') {
    const {latitude,longitude,epoch,window,slot}=c.input;
    const {row,col}=cell(latitude,longitude);
    actual={row,col,...generate(epoch,window,row,col,slot,catalogueV1)};
  } else if (c.kind==='clock') actual=clock(c.input.utc);
  else if (c.kind==='weightedPick') actual=pick(catalogueV1.windowPools[c.input.pool],c.input.u2);
  else if (c.kind==='round') {
    const x=c.input.negativeZero?-0:c.input.x,y=x*1e6,r=Math.trunc(y),value=round6(x);
    actual={scaled:y,truncated:r,roundAway:Math.abs(y-r)>=0.5,value,negativeZero:Object.is(value,-0)};
  } else assert.fail(`unhandled fixture kind ${c.kind}`);
  // JSON loses the sign of zero; its explicit sign probes above must still match.
  assert.deepEqual(JSON.parse(JSON.stringify(actual)),c.expected);
});
