import fs from 'node:fs';
import {PrismaClient} from '@prisma/client';
const [path]=process.argv.slice(2);const review=JSON.parse(fs.readFileSync(path));
if(!review.reviewer || !['single','mixed','unknown','lookalike'].includes(review.category) || !Array.isArray(review.foodIds) || !['veg','egg','non_veg','unknown'].includes(review.dietaryType) || review.privacyReviewed!==true) throw new Error('Complete human food/privacy review required');
const db=new PrismaClient();
try {
 const row=await db.foodPhotoContribution.findUniqueOrThrow({where:{id:review.id}});
 if(row.expiresAt<=new Date()) throw new Error('Expired contribution');
 await db.foodPhotoContribution.update({where:{id:row.id},data:{label:{strength:'strong',category:review.category,foodIds:review.foodIds,dietaryType:review.dietaryType,version:review.version || 1,history:[...(row.label?.history || []),...(row.label ? [{...row.label,history:undefined,reviewer:row.reviewer,reviewedAt:row.reviewedAt}] : [])]},reviewer:review.reviewer,reviewedAt:new Date()}});
} finally {await db.$disconnect();}
