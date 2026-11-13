// Offline review inputs only. Never connects to a DB, invokes Prisma or resolves history.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const parentCommit='5214fa8dd8242093e542bd89a169dcf9321753b2';
export const candidateCommit='5c18daf262a5d2941f5b4964d279d47ec9635e33';
export const forwardNames=[
  '20261023000000_exploration_core',
  '20261023000100_drop_unreleased_collectible_find',
  '20261023170000_explore_receipt_telemetry',
];
const schemaPath='services/auth-service/prisma/schema.prisma';
const migrationPath='services/auth-service/prisma/migrations/';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function reviewInputs(root) {
  const git=args=>{
    const result=spawnSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root});
    if(result.status!==0)throw new Error('Frozen Git input unavailable');
    return result.stdout;
  };
  const read=(commit,path)=>git(['show',`${commit}:${path}`]);
  const files=[{path:'parent.prisma',bytes:read(parentCommit,schemaPath)}];
  const paths=git(['ls-tree','-r','--name-only',parentCommit,'--',migrationPath]).toString().trim().split('\n');
  if(paths.length!==37 || paths.some(path=>!path.startsWith(migrationPath)))throw new Error('Unexpected parent migration set');
  for(const path of paths) {
    const bytes=read(parentCommit,path);
    if(!bytes.equals(read(candidateCommit,path)))throw new Error('Historical bytes differ in candidate');
    files.push({path:'historical/'+path.slice(migrationPath.length),bytes});
  }
  for(const name of forwardNames)files.push({path:`forward/${name}/migration.sql`,bytes:read(candidateCommit,`${migrationPath}${name}/migration.sql`)});
  const manifest={
    kind:'review-inputs-only',parentCommit,candidateCommit,
    historicalReplay:'failed in hosted run 40057075433; not repaired by this package',
    proposedFreshStrategy:'explicit parent-schema bootstrap plus distinct schema baseline, then three forward migrations; requires parent acceptance change',
    existingUpgrade:'preserve all applied rows; inspect schema/history before applying only pending forward migrations; no automatic resolve',
    historicalMigrationCount:36,forwardNames,
    files:files.map(({path,bytes})=>({path,sha256:sha256(bytes)})),
  };
  return {files,manifest};
}

export function writeReviewPackage(root,output) {
  const {files,manifest}=reviewInputs(root);
  // Refuse even an existing empty directory: never replace another rehearsal.
  mkdirSync(output);
  for(const {path,bytes} of files) {
    const target=resolve(output,path);
    mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,bytes,{flag:'wx'});
  }
  writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3)throw new Error('Usage: node tools/explore-e2/provisioning-inputs.mjs <new-output-directory>');
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const manifest=writeReviewPackage(root,resolve(process.argv[2]));
  console.log(JSON.stringify(manifest,null,2));
}
