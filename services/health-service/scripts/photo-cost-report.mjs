import fs from 'node:fs';
import {priceUsage} from '../services/ledger/photoMeasurement.js';
const [usagePath,pricingPath]=process.argv.slice(2);
const rows=JSON.parse(fs.readFileSync(usagePath));
const pricing=JSON.parse(fs.readFileSync(pricingPath));
if(!pricing.version || !pricing.effectiveFrom || !pricing.effectiveTo || pricing.tax!=='excluded' || pricing.currency!=='USD') throw new Error('Versioned USD tax-exclusive pricing required');
let total=0,missing=0;
for(const row of rows) {
 const date=new Date(row.requestedAt);
 const rate=pricing.models[row.model];
 const cost = date>=new Date(pricing.effectiveFrom)&&date<new Date(pricing.effectiveTo)&&rate ? priceUsage(row,rate):null;
 if(cost==null) missing++; else total+=cost;
}
console.log(JSON.stringify({pricingVersion:pricing.version,tax:'excluded',scope:'provider tokens only',calls:rows.length,incompleteCalls:missing,totalUsd:missing?null:total,knownSubtotalUsd:total},null,2));
