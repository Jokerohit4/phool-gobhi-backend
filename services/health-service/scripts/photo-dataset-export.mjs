// Read-only export of consented reviewed metadata. Never exports image bytes/paths.
import fs from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {createHmac} from 'node:crypto';
import {splitPerson} from '../services/ledger/photoEvaluation.js';
const [outPath]=process.argv.slice(2);
if(!process.env.PHOTO_DATASET_SALT) throw new Error('Stable private dataset salt required');
const db=new PrismaClient();
try {
 // Unreviewed copies with a weak/stronger label are exported too; they may only
 // land in the reference split (validateDataset enforces it).
 const rows=(await db.foodPhotoContribution.findMany({where:{expiresAt:{gt:new Date()}}})).filter(r=>r.reviewedAt || ['weak','stronger'].includes(r.label?.strength));
 const labels=rows.map(r=>{const person=createHmac('sha256',process.env.PHOTO_DATASET_SALT).update(String(r.userId)).digest('hex');const split=splitPerson(person,process.env.PHOTO_DATASET_SALT);return {id:r.id,person,split:r.reviewedAt || split==='reference' ? split : 'unusable',consentVersion:r.consentVersion,expiresAt:r.expiresAt,reviewer:r.reviewer,...r.label,fold:parseInt(person.slice(0,2),16)%2===0?'fit':'selection'};});
 fs.writeFileSync(outPath,JSON.stringify({labels:labels.filter(l=>l.split!=='unusable')},null,2),{flag:'wx'});
} finally {await db.$disconnect();}
