import fs from 'node:fs';
import {validateDataset,selectWinner,report,digest,passes} from '../services/ledger/photoEvaluation.js';
const [command,inputPath,outPath]=process.argv.slice(2);
const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
validateDataset(input.labels);
if(command==='select') {
 if(input.labels.some(l=>l.split==='holdout')) throw new Error('Selection input must exclude holdout labels');
 const winner=selectWinner(input.labels,input.arms,input.rules,input.baseline);
 if(!winner) throw new Error('Insufficient validation data or no passing configuration');
 const frozen={people: [...new Set(input.labels.map(l=>digest(l.person)))], version:1,winner:winner.config,baseline:input.baseline,configurations:input.configurations,rules:input.rules,validationDigest:digest(input),holdoutId:input.holdoutId,createdAt:new Date().toISOString()};
 fs.writeFileSync(outPath,JSON.stringify({...frozen,hash:digest(frozen)},null,2),{flag:'wx'});
} else if(command==='holdout') {
 const {hash,...frozen}=input.frozen;
 if(digest(frozen)!==hash) throw new Error('Freeze modified');
 if(input.labels.some(l=>frozen.people.includes(digest(l.person)))) throw new Error('Person leakage across frozen splits');
 if(input.holdoutId!==frozen.holdoutId || input.labels.some(l=>l.split!=='holdout')) throw new Error('Wrong holdout');
 // Exclusive claim BEFORE reading predictions: failed runs also consume this holdout.
 fs.mkdirSync('.photo-holdouts',{recursive:true});
 const people=input.labels.map(l=>digest(l.person));
 for(const path of fs.readdirSync('.photo-holdouts')) {const prior=JSON.parse(fs.readFileSync('.photo-holdouts/'+path));if(prior.people.some(p=>people.includes(p))) throw new Error('Fresh holdout people required');}
 fs.writeFileSync('.photo-holdouts/'+digest(input.holdoutId)+'.opened',JSON.stringify({hash,people}),{flag:'wx'});
 const result={freeze:hash,winner:report(input.labels,input.arms[frozen.winner]),baseline:report(input.labels,input.arms[frozen.baseline])};
 result.passed = passes(result.winner,result.baseline,frozen.rules) && result.baseline.totalCostUsd!=null && result.winner.totalCostUsd<result.baseline.totalCostUsd;
 fs.writeFileSync(outPath,JSON.stringify(result,null,2),{flag:'wx'});
} else throw new Error('Use select or holdout');
