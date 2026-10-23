import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cell, round6, pick, clock, generate } from '../exploration/generator.js';
import { catalogueV1, hash } from '../exploration/contracts.js';

// Frozen copies are resolved relative to this test, independent of the checkout path or cwd.
const fixture=JSON.parse(readFileSync(new URL('../exploration/contract/generator-v1-fixtures.json',import.meta.url),'utf8'));
const apiFixture=JSON.parse(readFileSync(new URL('../exploration/contract/api-fixtures.json',import.meta.url),'utf8'));
test('vendored catalogue contentHash agrees with generator and API fixture catalogueHash bindings',()=>{
  const {contentHash,...payload}=catalogueV1;
  assert.equal(hash(payload),contentHash);
  assert.equal(fixture.catalogueHash,contentHash);
  const bindings=apiFixture.manifests.filter(m=>m.catalogueVersion===catalogueV1.catalogueVersion);
  assert.ok(bindings.length>0);
  for(const manifest of bindings)assert.equal(manifest.catalogueHash,contentHash);
  const catalogueRead=apiFixture.httpCases.find(c=>c.name==='catalogue-manifest-bound');
  assert.equal(catalogueRead.response.body.data.contentHash,contentHash);
});
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
