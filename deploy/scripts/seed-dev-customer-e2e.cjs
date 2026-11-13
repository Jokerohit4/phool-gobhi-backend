// Rich, repeatable fixtures for the confirmed dev OTP account (user 7).
// node deploy/scripts/seed-dev-customer-e2e.cjs --apply
// No payment-provider calls, notifications, consent grants or feature-flag edits.
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {createHmac}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const {Client}=createRequire(path.join(__dirname,'../../package.json'))('pg');
const USER=7, TAG='dev-e2e-v1:7', BASE='https://gateway-dev-1077801427223.asia-south1.run.app';
const SUMMARY={environment:'dev',userId:USER,created:{}};
const q=s=>'"'+s.replaceAll('"','""')+'"';
function secret(){return JSON.parse(execFileSync('gcloud.cmd',['secrets','versions','access','latest','--secret=auth-service-secrets-dev','--project=phool-gobhi'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000}));}
function day(offset=0){const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});return new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);}
function at(offset,hour='07:00'){const value=new Date(`${day(offset)}T${hour.padStart(5,'0')}:00+05:30`);if(Number.isNaN(value.getTime()))throw Error(`Invalid fixture time ${offset}/${hour}`);return value;}
function token(key){const enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const now=Math.floor(Date.now()/1000);const data=enc({alg:'HS256',typ:'JWT'})+'.'+enc({id:USER,role:'customer',type:'general',iat:now,exp:now+1800});return data+'.'+createHmac('sha256',key).update(data).digest('base64url');}
let client,columns,bearer;
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
async function api(route,method='GET',body){
 const response=await fetch(BASE+route,{method,headers:{Authorization:'Bearer '+bearer,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body?body instanceof FormData?body:JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
 const result=await response.json();if(!response.ok)throw Error(`${method} ${route}: ${response.status} ${result.error||result.message||''}`);return result;
}
function line(offset,text){return {createdAt:at(offset,'18:30'),body:text};}
async function money(wallet,type,amount,key,description,offset=0){
 const exists=(await client.query('SELECT * FROM wallet."WalletTransaction" WHERE "idempotencyKey"=$1',[TAG+':'+key])).rows[0];if(exists)return exists;
 const tx=await ensure('wallet','WalletTransaction',{idempotencyKey:TAG+':'+key},{walletId:wallet.id,type,amount,status:'success',description:'[Dev demo] '+description,createdAt:at(offset)});
 await client.query('UPDATE wallet."Wallet" SET balance=balance+$1,"updatedAt"=now() WHERE id=$2',[type==='debit'?-amount:amount,wallet.id]);return tx;
}
function polyline(points){let last=[0,0],out='';for(const p of points){const coords=p.map(x=>Math.round(x*1e5));for(let i=0;i<2;i++){let n=coords[i]-last[i];n=n<0?~(n<<1):n<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>=5;}out+=String.fromCharCode(n+63);}last=coords;}return out;}
async function seed(){
 const user=(await client.query('SELECT * FROM auth."User" WHERE id=$1',[USER])).rows[0];
 if(!user||user.role!=='customer'||user.phone!=='9999999999')throw Error('Wrong dev customer account');
 const gym=(await client.query('SELECT * FROM gym."Gym" WHERE id=$1 AND "isActive"=true',[user.linkedGymId])).rows[0];if(!gym)throw Error('Expected the account\'s linked dev gym');SUMMARY.gym={id:gym.id,name:gym.name};
 const wallet=await ensure('wallet','Wallet',{userId:USER},{userType:'customer',balance:0});
 await money(wallet,'credit',7500,'starter-credit','Test wallet credit');
 const exerciseRows=(await client.query('SELECT id,name,"loggingType" FROM health."Exercise" WHERE id=ANY($1::int[]) ORDER BY id',[[1,2,4,5,6,8,9,10,11]])).rows;
 if(exerciseRows.length<9)throw Error('Exercise catalogue is incomplete');
 const routines=[];
 for(const [index,name] of ['Push','Pull','Legs'].entries()){
  const template=await ensure('health','WorkoutTemplate',{userId:USER,name:`Demo ${name} Day`},{isSystem:false,description:'Development fixture: editable routine with progression',estMinutes:45,level:'intermediate'});routines.push(template);
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
  await ensure('health','RunTrack',{exerciseRecordId:record.id},{polyline:route,thumbPolyline:route,splits:[1,2,3,4,5].map(km=>({km,seconds:360-i*12})),movingSeconds:1800-i*60,elapsedSeconds:1860-i*60,avgPaceSecPerKm:360-i*12,bestKmSeconds:348-i*12,pauseCount:1,pointCount:30,weightKgUsed:82,platform:'android',appVersion:'dev-e2e-v1'});
 }
 for(let i=0;i<30;i++){
  const offset=-i;
  await ensure('health','DailyActivityMetric',{userId:USER,date:day(offset)},{steps:5200+(i*739)%7200,activeCalories:280+(i*37)%330,distanceMeters:4200+(i*433)%5200,restingHeartRateBpm:58+i%8,source:'health_connect',syncedAt:at(offset,'20:00')});
  const metrics={weight:[82+Math.floor(i/5)*0.2,'kg'],body_fat:[21+i*0.02,'%'],resting_hr:[60+i%6,'bpm'],sleep_minutes:[420+(i%5)*15,'min'],hrv:[48+i%13,'ms'],stress:[2+i%3,'score']};
  if(i%3===0)for(const[metric,[value,unit]]of Object.entries(metrics))await ensure('health','BiometricEntry',{userId:USER,metric,localDate:day(offset)},{value,unit,source:'manual',createdAt:at(offset)});
  const waterCounts=i===0?3:5+(i%4);
  for(let drink=0;drink<waterCounts;drink++)await ensure('health','WaterLog',{userId:USER,localDate:day(offset),createdAt:at(offset,`${String(8+drink).padStart(2,'0')}:15`)},{ml:300});
  if(i>=7){const close=300+(29-i)*5;await ensure('health','ScoreDaySnapshot',{userId:USER,localDate:day(offset)},{open:close-5,high:close+3,low:close-5,close,breakdown:[{key:'dev_e2e',label:'Demo daily consistency',kind:'earned',points:5,detail:'Synthetic development fixture'}],rulesVersion:'dev-e2e-v1',closedAt:at(offset,'23:00')});}
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
 for(const offset of [-14,3,12])await ensure('health','DoctorAppointment',{userId:USER,doctorName:'Demo doctor',localDate:day(offset)},{speciality:'Sample follow-up',localTime:'11:00',followUpDate:day(offset+14),notes:'Synthetic development appointment; not a real booking.'});
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
 const coinKey=TAG+':coins';if(!(await client.query('SELECT id FROM challenge."CoinLedgerEntry" WHERE "idempotencyKey"=$1',[coinKey])).rowCount){await ensure('challenge','CoinLedgerEntry',{idempotencyKey:coinKey},{userId:USER,type:'credit',amount:1000,description:'[Dev demo] End-to-end testing coins'});await client.query('UPDATE challenge."CoinBalance" SET balance=balance+1000,"updatedAt"=now() WHERE id=$1',[balance.id]);}
 const definition=await ensure('challenge','ChallengeDefinition',{key:'dev_e2e_show_up_v1'},{type:'off_peak_hunter',category:'gym_native',title:'Demo: Show Up Week',description:'A development challenge for testing progress and completion.',defaultVerificationMethod:'booking_attendance'});
 for(const[mode,status,progress]of [['active','active',2],['completed','completed',3]]){
  const challenge=await ensure('challenge','Challenge',{challengeDefinitionId:definition.id,city:'Gurugram',status},{startsAt:at(mode==='active'?-3:-20),endsAt:at(mode==='active'?10:-5),targetCount:3,rewardCoins:50,lat:Number(gym.lat),lng:Number(gym.lng),offPeakWindows:[{startHourIst:0,endHourIst:24}]});
  await ensure('challenge','ChallengeEnrollment',{userId:USER,challengeId:challenge.id},{status:mode==='active'?'active':'completed',progressCount:progress,startedAt:at(mode==='active'?-3:-20),completedAt:mode==='active'?null:at(-5)});
 }
 SUMMARY.walletBalance=(await client.query('SELECT balance FROM wallet."Wallet" WHERE id=$1',[wallet.id])).rows[0].balance;
 SUMMARY.routineIds=routines.map(r=>r.id);SUMMARY.matchedBuddies=matches.length;
}
async function main(){
 const auth=secret();bearer=token(auth.JWT_SECRET);client=new Client({connectionString:auth.DATABASE_URL,connectionTimeoutMillis:15000,query_timeout:30000});await client.connect();
 try{
  columns=(await client.query(`SELECT table_schema,table_name,column_name,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema IN ('auth','health','booking','wallet','buddy','challenge')`)).rows;
  if(!process.argv.includes('--apply')){console.log(JSON.stringify({mode:'plan',environment:'dev',userId:USER,areas:['workouts','bookings','attendance','wallet','subscriptions','gifts','runs','activity','biometrics','water','scores','food','saved meals','supplements','plan completion','appointments','buddy chats','paired streaks','coins','challenges']}));return;}
  await client.query('BEGIN');await client.query(`SELECT pg_advisory_xact_lock(hashtext('dev-customer-e2e-7'))`);await seed();await client.query('COMMIT');SUMMARY.committed=true;
  console.log(JSON.stringify(SUMMARY,null,2));
 }catch(err){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:err.message,code:err.code}));process.exitCode=1;}finally{await client.end();}
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
