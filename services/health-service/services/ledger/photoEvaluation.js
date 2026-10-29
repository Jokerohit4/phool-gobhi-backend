import {createHash} from 'node:crypto';
export const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function splitPerson(person, salt) {
 const n=parseInt(digest([salt,person]).slice(0,8),16)%100;
 return n<50?'reference':n<80?'validation':'holdout';
}
export function validateDataset(rows) {
 const people=new Map(); const ids=new Set();
 for(const r of rows) {
 if(!r.id || ids.has(r.id) || !r.person || !r.consentVersion || !r.expiresAt || new Date(r.expiresAt)<=new Date()) throw new Error('Invalid/expired/duplicate contribution');
 ids.add(r.id);
 if(!['reference','validation','holdout'].includes(r.split)) throw new Error('Invalid split');
 if(people.has(r.person)&&people.get(r.person)!==r.split) throw new Error('Person leakage');
 people.set(r.person,r.split);
 // Reference photos may carry weak labels (user accepted the model's answer).
 // Calibration and final-test photos must be human-reviewed ('strong').
 if(!['weak','stronger','strong'].includes(r.strength)) throw new Error('Label strength required');
 if(r.split!=='reference' && (r.strength!=='strong' || !r.reviewer || !['single','unknown','mixed','lookalike'].includes(r.category) || !Array.isArray(r.foodIds) || !['veg','egg','non_veg','unknown'].includes(r.dietaryType))) throw new Error('Human-reviewed label required');
 }
}
export function wilson(k,n) {
 if(!n) return null; const z=1.96,d=1+z*z/n,c=(k/n+z*z/(2*n))/d;
 const h=z*Math.sqrt(k/n*(1-k/n)/n+z*z/(4*n*n))/d; return [c-h,c+h];
}
export function report(labels, predictions) {
 if(!labels.length) return {limitation:'No labelled data',n:0};
 const byId=new Map(predictions.map(p=>[p.id,p]));
 if(byId.size!==predictions.length || predictions.some(p=>!labels.some(l=>l.id===p.id))) throw new Error('Unexpected predictions');
 let accepted=0,correct=0,failures=0,dietaryErrors=0,unknownFalseAccepts=0,cost=0,missingCost=0,offShortlist=0,offShortlistCorrect=0; const latency=[];
 for(const l of labels) {
 const p=byId.get(l.id);
 if(!p || p.failed) failures++;
 if(p?.latencyMs>=0) latency.push(p.latencyMs);
 if(typeof p?.costUsd==='number' && p.costUsd>=0) cost+=p.costUsd;else missingCost++;
 const right=JSON.stringify([...(p?.foodIds||[])].sort())===JSON.stringify([...l.foodIds].sort()) && l.category!=='unknown';
 // How often the right food was missing from the hint shortlist, and whether
 // full-catalogue matching still found it.
 if(p?.shortlistHit===false) {offShortlist++; if(right && p.accepted && !p.failed) offShortlistCorrect++;}
 if(p?.accepted && !p.failed) {
 accepted++;
 if(right) correct++;
 if(l.dietaryType!=='unknown'&&p.dietaryType!==l.dietaryType) dietaryErrors++;
 if(l.category==='unknown') unknownFalseAccepts++;
 }
 }
 latency.sort((a,b)=>a-b);
 return {n:labels.length,accepted,correct,precision:accepted?correct/accepted:null,precision95:wilson(correct,accepted),coverage:accepted/labels.length,coverage95:wilson(accepted,labels.length),dietaryErrors,unknownFalseAccepts,offShortlist,offShortlistCorrect,failureRate:failures/labels.length,failure95:wilson(failures,labels.length),p95LatencyMs:latency.length?latency[Math.ceil(.95*latency.length)-1]:null,latencyMissing:labels.length-latency.length,totalCostUsd:missingCost?null:cost,knownCostUsd:cost,missingCost,tax:'excluded',costScope:'provider calls only; infrastructure/storage excluded'};
}
// The roadmap's pass rule: precision lower bound at or above the floor, zero
// veg / non-veg errors, and - against the current configuration - precision
// not worse and unknown foods handled no worse. Cheapest passing arm wins.
export function passes(candidate, baseline, rules) {
 return candidate.precision95?.[0]>=rules.precisionLower && candidate.coverage>=rules.minCoverage &&
 candidate.dietaryErrors===0 && candidate.totalCostUsd!=null &&
 (!baseline || ((candidate.precision ?? 0)>=(baseline.precision ?? 0) && candidate.unknownFalseAccepts<=baseline.unknownFalseAccepts));
}
export function selectWinner(labels, arms, rules, baselineId) {
 const valid=labels.filter(l=>l.split==='validation' && l.fold!=='fit');
 const reports=Object.entries(arms).map(([config,p])=>({config,report:report(valid,p.filter(x=>valid.some(l=>l.id===x.id)))}));
 const baseline=reports.find(r=>r.config===baselineId)?.report;
 return reports.filter(x=>passes(x.report,baseline,rules)).sort((a,b)=>a.report.totalCostUsd-b.report.totalCostUsd)[0] || null;
}
