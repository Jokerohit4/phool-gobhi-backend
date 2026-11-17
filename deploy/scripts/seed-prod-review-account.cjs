// App Review demo data for PRODUCTION account 9999999999 (user 22), so Apple's
// reviewers see a populated app. Derived from seed-dev-customer-e2e.cjs.
//   node deploy/scripts/seed-prod-review-account.cjs                     (plan, writes nothing)
//   node deploy/scripts/seed-prod-review-account.cjs --apply --confirm-prod
// Idempotent: every row is created only if missing, all in ONE transaction that rolls back on
// any error. Rows are tagged review-demo-v1 / "[Demo]" so they can be found and removed.
// Deliberately NOT done in production: no payment-provider calls, notifications, consent
// grants, feature-flag edits, fake buddy users or city-wide challenges (all would be visible
// to real users), and every booking/attendance row uses gym 2, owned by the founder's own
// partner account, so no third-party partner is ever credited from demo wallet money.
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const path=require('node:path');
const fs=require('node:fs');
const {Client}=createRequire(path.join(__dirname,'../../package.json'))('pg');
const USER=22, TAG='review-demo-v1:22', GYM_ID=2, FOUNDER_PARTNER_PHONE='9354859197', STARTER_CREDIT=3000;
const SUMMARY={environment:'prod',userId:USER,created:{}};
const q=s=>'"'+s.replaceAll('"','""')+'"';
function secret(){return JSON.parse(execFileSync('gcloud.cmd',['secrets','versions','access','latest','--secret=auth-service-secrets-prod','--project=phool-gobhi'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000}));}
function day(offset=0){const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});return new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);}
function at(offset,hour='07:00'){const value=new Date(`${day(offset)}T${hour.padStart(5,'0')}:00+05:30`);if(Number.isNaN(value.getTime()))throw Error(`Invalid fixture time ${offset}/${hour}`);return value;}
let client,columns;
async function ensure(schema,table,where,data){
 const entries=Object.entries(where);const check=await client.query(`SELECT * FROM ${q(schema)}.${q(table)} WHERE ${entries.map(([k],i)=>q(k)+' IS NOT DISTINCT FROM $'+(i+1)).join(' AND ')} LIMIT 1`,entries.map(([,v])=>v));
 if(check.rows.length)return check.rows[0];
 const meta=columns.filter(c=>c.table_schema===schema&&c.table_name===table);
 const input={...where,...data};if(meta.some(c=>c.column_name==='updatedAt')&&!input.updatedAt)input.updatedAt=new Date();
 for(const c of meta){if(c.is_nullable==='NO'&&c.column_default===null&&!(c.column_name in input))throw Error(`Missing ${schema}.${table}.${c.column_name}`);}
 const keys=Object.keys(input);const values=keys.map(k=>{const v=input[k];const c=meta.find(c=>c.column_name===k);if(!c)throw Error(`Unknown ${table}.${k}`);return ['json','jsonb'].includes(c.udt_name)&&v!==null?JSON.stringify(v):v;});
 const result=await client.query(`INSERT INTO ${q(schema)}.${q(table)} (${keys.map(q).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values);
 const key=schema+'.'+table;SUMMARY.created[key]=(SUMMARY.created[key]||0)+1;return result.rows[0];
}
function line(offset,text){return {createdAt:at(offset,'18:30'),body:text};}
async function money(wallet,type,amount,key,description,offset=0){
 const exists=(await client.query('SELECT * FROM wallet."WalletTransaction" WHERE "idempotencyKey"=$1',[TAG+':'+key])).rows[0];if(exists)return exists;
 const tx=await ensure('wallet','WalletTransaction',{idempotencyKey:TAG+':'+key},{walletId:wallet.id,type,amount,status:'success',description:'[Demo] '+description,createdAt:at(offset)});
 await client.query('UPDATE wallet."Wallet" SET balance=balance+$1,"updatedAt"=now() WHERE id=$2',[type==='debit'?-amount:amount,wallet.id]);return tx;
}
function polyline(points){let last=[0,0],out='';for(const p of points){const coords=p.map(x=>Math.round(x*1e5));for(let i=0;i<2;i++){let n=coords[i]-last[i];n=n<0?~(n<<1):n<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>=5;}out+=String.fromCharCode(n+63);}last=coords;}return out;}
async function seed(){
 const user=(await client.query('SELECT * FROM auth."User" WHERE id=$1',[USER])).rows[0];
 if(!user||user.role!=='customer'||user.phone!=='9999999999')throw Error('Wrong review account');
 const gym=(await client.query('SELECT * FROM gym."Gym" WHERE id=$1',[GYM_ID])).rows[0];if(!gym)throw Error('Gym '+GYM_ID+' not found');
 const owner=(await client.query('SELECT phone FROM auth."User" WHERE id=$1',[Number(gym.partnerId)])).rows[0];
 if(!owner||owner.phone!==FOUNDER_PARTNER_PHONE)throw Error('Refusing: gym '+GYM_ID+' is not owned by the founder partner account, so demo wallet money could credit a real partner');
 SUMMARY.gym={id:gym.id,name:gym.name,isActive:gym.isActive};
 await client.query('UPDATE auth."User" SET "linkedGymId"=$1,"updatedAt"=now() WHERE id=$2 AND "linkedGymId" IS NULL',[GYM_ID,USER]);
 const wallet=await ensure('wallet','Wallet',{userId:USER},{userType:'customer',balance:0});
 await money(wallet,'credit',STARTER_CREDIT,'starter-credit','Demo wallet credit');
 const exerciseRows=(await client.query('SELECT id,name,"loggingType" FROM health."Exercise" WHERE id=ANY($1::int[]) ORDER BY id',[[1,2,4,5,6,8,9,10,11]])).rows;
 if(exerciseRows.length<9)throw Error('Exercise catalogue is incomplete');
 const routines=[];
 for(const [index,name] of ['Push','Pull','Legs'].entries()){
  const template=await ensure('health','WorkoutTemplate',{userId:USER,name:`Demo ${name} Day`},{isSystem:false,description:'Demo routine: edit it, or start a workout from it',estMinutes:45,level:'intermediate'});routines.push(template);
  for(let i=0;i<3;i++)await ensure('health','TemplateExercise',{templateId:template.id,order:i},{exerciseId:exerciseRows[index*3+i].id,targetSets:3,targetReps:10,repMin:8,repMax:12,targetWeightKg:[35,45,60][index],restSeconds:90,phase:'main'});
 }
 const offsets=[-29,-26,-23,-20,-17,-15,-13,-11,-9,-8,-6,-4,-2,-1];
 for(const [index,offset] of offsets.entries()){
  const routine=index%3;
  const booking=await ensure('booking','Booking',{customerId:USER,gymId:gym.id,date:day(offset),startTime:'07:00',endTime:'08:00'},{amount:0,commissionPct:100,partnerShare:0,status:'completed',attendedAt:at(offset),attendanceMethod:'manual_verify',payoutAmount:0,payoutCreditedAt:at(offset),createdAt:at(offset-1)});
  const attendance=await ensure('booking','MemberAttendance',{customerId:USER,gymId:gym.id,date:day(offset)},{checkedInAt:at(offset),checkedOutAt:at(offset,'08:00')});
  await ensure('challenge','AttendanceEventLog',{idempotencyKey:TAG+':attendance:'+day(offset)},{userId:USER,gymId:gym.id,bookingId:booking.id,memberAttendanceId:attendance.id,attendedAt:at(offset),source:'member_checkin',createdAt:at(offset)});
  const session=await ensure('health','WorkoutSession',{clientRef:TAG+':workout:'+day(offset)},{userId:USER,templateId:routines[routine].id,gymId:gym.id,bookingId:booking.id,startedAt:at(offset),endedAt:at(offset,'07:48'),localDate:day(offset),type:'strength',rpe:6+(index%3),attendedAt:at(offset),attendanceMethod:'manual_verify',coinsAwarded:true});
  for(let order=0;order<3;order++){
   const ex=await ensure('health','SessionExercise',{sessionId:session.id,order},{exerciseId:exerciseRows[routine*3+order].id,restSeconds:90,phase:'main'});
   for(let setNumber=1;setNumber<=3;setNumber++)await ensure('health','WorkoutSet',{sessionExerciseId:ex.id,setNumber},{weightKg:25+routine*10+Math.floor(index/3)*2.5,reps:10+(index%3),completed:true});
  }
 }
 // Future bookings remain actionable; an old cancellation already has its refund.
 for(const offset of [1,3,5]){
  const tx=await money(wallet,'debit',299,'upcoming:'+day(offset),'Upcoming demo session',-1);
  await ensure('booking','Booking',{customerId:USER,gymId:gym.id,date:day(offset),startTime:'18:00',endTime:'19:00'},{amount:299,commissionPct:100,partnerShare:0,status:'confirmed',walletTxId:tx.id});
 }
 const cancelled=await money(wallet,'debit',299,'cancelled-debit','Cancelled demo booking',-4);await money(wallet,'credit',299,'cancelled-refund','Refund for cancelled demo booking',-3);
  await ensure('booking','Booking',{customerId:USER,gymId:gym.id,date:day(-3),startTime:'12:00',status:'cancelled'},{endTime:'13:00',amount:299,commissionPct:100,partnerShare:0,walletTxId:cancelled.id,refundDueAmount:299,refundedAt:at(-3),cancellationReason:'work',createdAt:at(-4)});
 await ensure('auth','GymLink',{userId:USER,gymId:gym.id,removedAt:null},{source:'gym_qr',linkedAt:at(-35),firstVerifiedCheckinAt:at(-29)});
 const subKey=TAG+':subscription:active';
 if(!(await client.query('SELECT id FROM wallet."GymSubscription" WHERE "razorpayOrderId"=$1',[subKey])).rowCount){await money(wallet,'debit',1499,'subscription-debit','Demo monthly membership',-5);await ensure('wallet','GymSubscription',{razorpayOrderId:subKey},{customerId:USER,gymId:gym.id,partnerId:gym.partnerId,planType:'monthly',price:1499,commissionPct:100,partnerShare:0,startDate:at(-5),endDate:at(25),status:'active',payoutModel:'upfront',isAttendanceSaas:false});}
 await ensure('wallet','GymSubscription',{razorpayOrderId:TAG+':subscription:gift'},{customerId:USER,gymId:gym.id,partnerId:gym.partnerId,planType:'weekly',price:499,commissionPct:100,partnerShare:0,startDate:at(-20),endDate:at(-13),status:'active',payoutModel:'upfront',isAttendanceSaas:false,giftDaysGranted:2,giftDaysRedeemed:0,bonusPaid:true,closedOutAt:at(-12)});
 await ensure('health','WeeklyGoal',{userId:USER},{sessionsPerWeek:3,setByUser:true});
 const mondayOffset=-((new Date(day()+'T00:00:00Z').getUTCDay()+6)%7);
 for(let ago=0;ago<4;ago++)await ensure('challenge','UserStreakWeek',{userId:USER,weekStart:at(mondayOffset-ago*7,'00:00')},{checkinCount:ago?3:2,qualified:ago>0,closedAt:ago?at(mondayOffset-(ago-1)*7,'00:00'):null});
 await ensure('challenge','UserStreak',{userId:USER},{currentStreak:3,longestStreak:3,lastQualifiedWeekStart:at(mondayOffset-7,'00:00')});
 // Three recent GPS runs, with actual encoded route data and splits.
 for(const [i,offset] of [-12,-7,-3].entries()){
  const record=await ensure('health','ExerciseRecord',{userId:USER,externalId:TAG+':run:'+day(offset),source:'gps_tracker'},{type:'running',startedAt:at(offset,'06:15'),endedAt:at(offset,'06:45'),durationSeconds:1800-i*60,caloriesBurned:310+i*15,distanceMeters:5000,avgHeartRateBpm:142-i*2});
  const route=polyline(Array.from({length:30},(_,j)=>[Number(gym.lat)+0.001*j,Number(gym.lng)+Math.sin(j/4)*0.003]));
  await ensure('health','RunTrack',{exerciseRecordId:record.id},{polyline:route,thumbPolyline:route,splits:[1,2,3,4,5].map(km=>({km,seconds:360-i*12})),movingSeconds:1800-i*60,elapsedSeconds:1860-i*60,avgPaceSecPerKm:360-i*12,bestKmSeconds:348-i*12,pauseCount:1,pointCount:30,weightKgUsed:82,platform:'ios',appVersion:'review-demo-v1'});
 }
 for(let i=0;i<30;i++){
  const offset=-i;
  await ensure('health','DailyActivityMetric',{userId:USER,date:day(offset)},{steps:5200+(i*739)%7200,activeCalories:280+(i*37)%330,distanceMeters:4200+(i*433)%5200,restingHeartRateBpm:58+i%8,source:'health_connect',syncedAt:at(offset,'20:00')});
  const metrics={weight:[82+Math.floor(i/5)*0.2,'kg'],body_fat:[21+i*0.02,'%'],resting_hr:[60+i%6,'bpm'],sleep_minutes:[420+(i%5)*15,'min'],hrv:[48+i%13,'ms'],stress:[2+i%3,'score']};
  if(i%3===0)for(const[metric,[value,unit]]of Object.entries(metrics))await ensure('health','BiometricEntry',{userId:USER,metric,localDate:day(offset)},{value,unit,source:'manual',createdAt:at(offset)});
  const waterCounts=i===0?3:5+(i%4);
  for(let drink=0;drink<waterCounts;drink++)await ensure('health','WaterLog',{userId:USER,localDate:day(offset),createdAt:at(offset,`${String(8+drink).padStart(2,'0')}:15`)},{ml:300});
  if(i>=7){const close=300+(29-i)*5;await ensure('health','ScoreDaySnapshot',{userId:USER,localDate:day(offset)},{open:close-5,high:close+3,low:close-5,close,breakdown:[{key:'review_demo',label:'Demo daily consistency',kind:'earned',points:5,detail:'Demo data'}],rulesVersion:'review-demo-v1',closedAt:at(offset,'23:00')});}
 }
 const foods=(await client.query('SELECT * FROM health."FoodItem" WHERE id=ANY($1::int[]) ORDER BY id',[[1,2,3,9,10,11,12]])).rows;
 for(let i=0;i<14;i++)for(const[index,slot]of ['breakfast','lunch','snack','dinner'].entries()){
  if(i===0&&index>1)continue;
  const food=foods[(i+index)%foods.length],grams=[150,220,100,250][index];const nutrients={};
  for(const key of ['kcal','proteinG','carbsG','fatG','fibreG','ironMg','magnesiumMg','calciumMg','zincMg'])nutrients[key]=Math.round(Number(food[key]||0)*grams)/100;
  await ensure('health','FoodLog',{userId:USER,localDate:day(-i),slot,servingLabel:TAG+':meal:'+slot},{foodItemId:food.id,grams,servings:1,nutrients,source:'search',name:food.name,nonVeg:food.nonVeg,createdAt:at(-i,`${[8,13,16,20][index]}:00`)});
 }
 const meal=await ensure('health','SavedMeal',{userId:USER,name:'Demo dal and rice lunch'},{slot:'lunch'});
 for(const[index,id]of [1,10].entries()){const food=foods.find(f=>f.id===id);const grams=index?150:200;const nutrients={};for(const key of ['kcal','proteinG','carbsG','fatG','fibreG'])nutrients[key]=Number(food[key]||0)*grams/100;await ensure('health','SavedMealLine',{savedMealId:meal.id,order:index},{foodItemId:id,name:food.name,grams,servingLabel:'Demo serving',nutrients});}
 const supplement=await ensure('health','SupplementSchedule',{userId:USER,name:'Demo supplement (edit or remove)'},{times:['09:00'],active:true});
 for(let i=1;i<=10;i++)await ensure('health','SupplementLog',{userId:USER,scheduleId:supplement.id,localDate:day(-i)},{name:supplement.name,takenAt:at(-i,'09:00')});
 await ensure('health','PlanItem',{userId:USER,sourceRef:TAG+':stretch'},{kind:'habit',layerKey:'basics',title:'Demo: 10-minute stretch',schedule:'daily',origin:'user',active:true});
 await ensure('health','PlanItem',{userId:USER,sourceRef:'supplement:'+supplement.id},{kind:'habit',layerKey:'supplements',title:supplement.name,schedule:'daily',origin:'user',active:true});
 for(const offset of [-14,3,12])await ensure('health','DoctorAppointment',{userId:USER,doctorName:'Demo doctor',localDate:day(offset)},{speciality:'Sample follow-up',localTime:'11:00',followUpDate:day(offset+14),notes:'Demo appointment for app reviewers; not a real booking.'});
 const habit=(await client.query('SELECT id FROM health."PlanItem" WHERE "userId"=$1 AND "sourceRef"=$2',[USER,TAG+':stretch'])).rows[0];
 for(const offset of [-6,-5,-3,-1,0])await ensure('health','PlanItemCompletion',{userId:USER,planItemId:habit.id,localDate:day(offset)},{points:5,how:'manual',createdAt:at(offset,'08:30')});
 // Keep existing consents and body/profile choices; only fill a missing goal.
 await client.query(`UPDATE health."HealthGoal" SET goals=ARRAY['build_muscle','general_health']::health."HealthGoalType"[],"updatedAt"=now() WHERE "userId"=$1 AND cardinality(goals)=0`,[USER]);
 const matches=(await client.query(`SELECT m.*,u.name FROM buddy."Match" m JOIN auth."User" u ON u.id=CASE WHEN m."userLowId"=$1 THEN m."userHighId" ELSE m."userLowId" END WHERE (m."userLowId"=$1 OR m."userHighId"=$1) AND u.email LIKE 'league-demo-%@dev.phoolgobhi.invalid'`,[USER])).rows;
 for(const[index,match]of matches.entries()){
  const other=match.userLowId===USER?match.userHighId:match.userLowId;
  await ensure('buddy','ChatMessage',{matchId:match.id,senderId:other,body:'[Demo] Ready for our next workout?'},{createdAt:at(-1,'18:15'),readAt:index<2?null:at(-1,'18:20')});
  await ensure('buddy','ChatMessage',{matchId:match.id,senderId:USER,body:'[Demo] Yes! Let us keep the streak going.'},{createdAt:at(-1,'18:20'),readAt:at(-1,'18:25')});
 }
 if(matches[0])await ensure('challenge','PairedStreak',{matchId:matches[0].id},{userAId:USER,userBId:matches[0].userLowId===USER?matches[0].userHighId:matches[0].userLowId,currentStreak:2,longestStreak:3,lastQualifiedWeekStart:at(mondayOffset-7,'00:00')});
 const balance=await ensure('challenge','CoinBalance',{userId:USER},{balance:0});
 const coinKey=TAG+':coins';if(!(await client.query('SELECT id FROM challenge."CoinLedgerEntry" WHERE "idempotencyKey"=$1',[coinKey])).rowCount){await ensure('challenge','CoinLedgerEntry',{idempotencyKey:coinKey},{userId:USER,type:'credit',amount:1000,description:'[Demo] Welcome coins'});await client.query('UPDATE challenge."CoinBalance" SET balance=balance+1000,"updatedAt"=now() WHERE id=$1',[balance.id]);}
 SUMMARY.walletBalance=(await client.query('SELECT balance FROM wallet."Wallet" WHERE id=$1',[wallet.id])).rows[0].balance;
 SUMMARY.routineIds=routines.map(r=>r.id);SUMMARY.matchedBuddies=matches.length;
}
async function main(){
 const auth=secret();client=new Client({connectionString:auth.DATABASE_URL,connectionTimeoutMillis:15000,query_timeout:30000});await client.connect();
 try{
  columns=(await client.query(`SELECT table_schema,table_name,column_name,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema IN ('auth','health','booking','wallet','buddy','challenge')`)).rows;
  if(!process.argv.includes('--apply')||!process.argv.includes('--confirm-prod')){if(process.argv.includes('--apply'))console.log('Add --confirm-prod to write to PRODUCTION.');console.log(JSON.stringify({mode:'plan',environment:'prod',userId:USER,gymId:GYM_ID,starterCredit:STARTER_CREDIT,areas:['workouts','bookings','attendance','wallet','subscriptions','gifts','runs','activity','biometrics','water','scores','food','saved meals','supplements','plan completion','appointments','buddy chats','paired streaks','coins']}));return;}
  await client.query('BEGIN');await client.query(`SELECT pg_advisory_xact_lock(hashtext('review-demo-22'))`);await seed();await client.query('COMMIT');SUMMARY.committed=true;
  console.log(JSON.stringify(SUMMARY,null,2));
 }catch(err){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:err.message,code:err.code}));process.exitCode=1;}finally{await client.end();}
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
