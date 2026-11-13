import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeReviewPackage, reviewInputs } from './provisioning-inputs.mjs';

test('frozen provisioning package preserves bytes and refuses existing output',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const temporary=mkdtempSync(join(tmpdir(),'explore-e2-inputs-'));
  try {
    const output=join(temporary,'review');
    const manifest=writeReviewPackage(root,output);
    assert.equal(manifest.kind,'review-inputs-only');
    assert.equal(manifest.files.length,41);
    assert.deepEqual(manifest,reviewInputs(root).manifest);
    for(const file of manifest.files)assert.equal(createHash('sha256').update(readFileSync(join(output,file.path))).digest('hex'),file.sha256);
    const before=readFileSync(join(output,'manifest.json'));
    assert.throws(()=>writeReviewPackage(root,output),{code:'EEXIST'});
    assert.deepEqual(readFileSync(join(output,'manifest.json')),before);
    assert.match(readFileSync(join(output,'parent.prisma'),'utf8'),/model CollectibleFind/);
    assert.doesNotMatch(readFileSync(join(output,'parent.prisma'),'utf8'),/model Explore/);
  } finally {
    assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('explore-e2-inputs-'));
    rmSync(temporary,{recursive:true,force:true});
  }
});
