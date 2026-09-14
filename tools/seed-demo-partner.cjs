const { Client } = require('pg');

const DATABASE_URL = process.env.SEED_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('SEED_DATABASE_URL not set');
  process.exit(1);
}

const PARTNER_PHONE = '9354859197';
const GYM_NAME = 'PhoolGobhi Fitness Lab';
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const HISTORY_DAYS = 60;

const client = new Client({ connectionString: DATABASE_URL });
const _query = client.query.bind(client);
client.query = async (...args) => {
  try {
    return await _query(...args);
  } catch (e) {
    console.error('SQL FAILED:', String(args[0] || '').slice(0, 200));
    throw e;
  }
};

let gymId;
let partnerId;
let linkedMembers = [];
let trainerRows = [];
let walkinRows = [];
let subscriptionsByCustomer = new Map();
let bookings = [];

// ---------- helpers ----------

function istShifted(dayBack) {
  return new Date(Date.now() + IST_OFFSET_MS - dayBack * 86400000);
}
function istDateString(dayBack) {
  return istShifted(dayBack).toISOString().slice(0, 10);
}
function istWeekday(dayBack) {
  const p = istDateString(dayBack).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}
function slotIso(dayBack, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${istDateString(dayBack)}T${hh}:${mm}:00+05:30`).toISOString();
}
function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}
function hhmm(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
function sessionPrice(hour) {
  return [6, 7, 8, 17, 18, 19, 20].includes(hour) ? 399 : 299;
}
function rnd() {
  return Math.random();
}

// ---------- seed data ----------

const MEMBERS = [
  { name: 'Rahul Sharma', phone: '9880755001', weekdays: [1, 2, 3, 4, 5], hour: 7, minute: 0, leaderboard: true, plans: [
    { planType: 'weekly', price: 500, startedDaysAgo: 40, duration: 7, coin: 0 },
    { planType: 'monthly', price: 1600, startedDaysAgo: 14, duration: 30, coin: 100 },
  ] },
  { name: 'Priya Verma', phone: '9880755002', weekdays: [1, 2, 3, 4, 5], hour: 18, minute: 0, leaderboard: true, plans: [
    { planType: 'weekly', price: 500, startedDaysAgo: 52, duration: 7, coin: 0 },
    { planType: 'monthly', price: 1600, startedDaysAgo: 20, duration: 30, coin: 0 },
  ] },
  { name: 'Aman Gupta', phone: '9880755003', weekdays: [2, 4, 6], hour: 7, minute: 30, leaderboard: true, plans: [
    { planType: 'monthly', price: 1600, startedDaysAgo: 30, duration: 30, coin: 0 },
  ] },
  { name: 'Neha Singh', phone: '9880755004', weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0, vari: true, leaderboard: false, plans: [
    { planType: 'weekly', price: 500, startedDaysAgo: 45, duration: 7, coin: 0 },
    { planType: 'monthly', price: 1600, startedDaysAgo: 8, duration: 30, coin: 0 },
  ] },
  { name: 'Vikram Mehta', phone: '9880755005', weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 6, minute: 15, leaderboard: true, plans: [
    { planType: 'monthly', price: 1600, startedDaysAgo: 35, duration: 30, coin: 0 },
  ] },
  { name: 'Sana Khan', phone: '9880755006', weekdays: [1, 3, 5], hour: 19, minute: 0, leaderboard: true, plans: [
    { planType: 'weekly', price: 500, startedDaysAgo: 30, duration: 7, coin: 0 },
    { planType: 'monthly', price: 1600, startedDaysAgo: 22, duration: 30, coin: 0 },
  ] },
  { name: 'Arjun Rao', phone: '9880755007', weekdays: [2, 4], hour: 6, minute: 30, leaderboard: false, plans: [
    { planType: 'monthly', price: 1600, startedDaysAgo: 10, duration: 30, coin: 0 },
  ] },
  { name: 'Divya Nair', phone: '9880755008', weekdays: [0, 6], hour: 10, minute: 0, leaderboard: true, plans: [
    { planType: 'quarterly', price: 3200, startedDaysAgo: 40, duration: 90, coin: 200 },
  ] },
  { name: 'Karan Malhotra', phone: '9880755009', weekdays: [1, 3, 5], hour: 8, minute: 0, leaderboard: true, plans: [
    { planType: 'monthly', price: 1600, startedDaysAgo: 25, duration: 30, coin: 0 },
  ] },
  { name: 'Ritu Kapoor', phone: '9880755010', weekdays: [1, 2, 3, 4, 5], hour: 17, minute: 30, leaderboard: true, plans: [
    { planType: 'weekly', price: 500, startedDaysAgo: 55, duration: 7, coin: 0 },
    { planType: 'monthly', price: 1600, startedDaysAgo: 3, duration: 30, coin: 0 },
  ] },
  { name: 'Sameer Joshi', phone: '9880755011', weekdays: [1, 3, 5], hour: 20, minute: 0, leaderboard: false, plans: [
    { planType: 'monthly', price: 1600, startedDaysAgo: 18, duration: 30, coin: 0 },
  ] },
  { name: 'Anita Desai', phone: '9880755012', weekdays: [2, 4, 6], hour: 18, minute: 30, leaderboard: true, plans: [
    { planType: 'monthly', price: 1600, startedDaysAgo: 12, duration: 30, coin: 0 },
  ] },
  { name: 'Farhan Ali', phone: '9880755013', weekdays: [1, 3, 5, 6], hour: 6, minute: 45, leaderboard: true, plans: [
    { planType: 'quarterly', price: 3200, startedDaysAgo: 50, duration: 90, coin: 0 },
  ] },
];

const E2E_CUSTOMER = {
  name: 'E2E Customer', phone: '+919354859197', weekdays: [1, 3, 5], hour: 7, minute: 0, leaderboard: true,
  plans: [
    { planType: 'weekly', price: 500, startedDaysAgo: 40, duration: 7, coin: 0 },
    { planType: 'monthly', price: 1600, startedDaysAgo: 15, duration: 30, coin: 0 },
  ],
};

const TRAINERS = [
  { name: 'Coach Sunil', phone: '9880755051', weekdays: [1, 2, 3, 4, 5, 6], hour: 7, isActive: true, createdDaysAgo: 90 },
  { name: 'Coach Meera', phone: '9880755052', weekdays: [1, 2, 3, 4, 5], hour: 18, isActive: true, createdDaysAgo: 60 },
  { name: 'Coach Daniel', phone: '9880755053', weekdays: [1, 3, 5, 6], hour: 8, isActive: true, createdDaysAgo: 30 },
];

const WALKINS = [
  { name: 'Mohit Chauhan', phone: '9880755021', weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
  { name: 'Sneha Bhat', phone: '9880755022', weekdays: [2, 4, 6], hour: 18, minute: 0 },
  { name: 'Rohan Kulkarni', phone: '9880755023', weekdays: [1, 3, 5], hour: 7, minute: 0 },
  { name: 'Ishita Bose', phone: '9880755024', weekdays: [3, 5, 6], hour: 19, minute: 0 },
  { name: 'Gaurav Rathore', phone: '9880755025', weekdays: [1, 2, 4], hour: 6, minute: 0 },
  { name: 'Pooja Iyer', phone: '9880755026', weekdays: [2, 5, 6], hour: 17, minute: 0 },
];

const ATTENDANCE_METHODS = ['qr_scan', 'qr_scan', 'qr_scan', 'manual_verify', 'qr_geofence_self'];

function perVisitShare(sub) {
  const days = sub.planType === 'weekly' ? 7 : sub.planType === 'monthly' ? 30 : 90;
  return Math.round((Number(sub.partnerShare) / days) * 100) / 100;
}
function primarySub(customerId) {
  const subs = subscriptionsByCustomer.get(customerId) || [];
  if (subs.length === 0) return null;
  return subs.reduce((best, s) => (new Date(s.endDate) > new Date(best.endDate) ? s : best));
}

// ---------- main ----------

async function run() {
  await client.connect();
  try {
    await client.query('begin');

    // 1. gym
    const pr = await client.query('select id from auth."User" where phone = $1', [PARTNER_PHONE]);
    if (pr.rows.length === 0) throw new Error(`partner ${PARTNER_PHONE} not found`);
    partnerId = pr.rows[0].id;

    const gr = await client.query(
      `select id from gym."Gym" where "partnerId" = $1 and name = $2`, [partnerId, GYM_NAME]
    );
    if (gr.rows.length > 0) {
      gymId = gr.rows[0].id;
      console.log('reusing gym', gymId);
    } else {
      const created = await client.query(
        `insert into gym."Gym"
           ("partnerId","name","description","address","city","state","lat","lng","amenities","phone","sessionPrice","quotedPrice","brandDocs","openTime","closeTime","slotDuration","capacity","isApproved","isActive","marketplaceEnabled","attendanceSaasOptedOut","subscriptionPricingMode","commissionPct","subscriptionCommissionPct","partnershipStartDate","weeklyPlanPrice","monthlyPlanPrice","quarterlyPlanPrice","createdAt","updatedAt")
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,60,25,true,true,true,false,'percentage'::gym."SubscriptionPricingMode",20,30,now(),500,1600,3200,now(),now())
         returning id`,
        [partnerId, GYM_NAME, 'Demo gym for judging Members, Trainers and Gym Insights.', 'Lobby 12, Cyber Hub, Sector 43', 'Gurugram', 'Haryana', 28.4595, 77.0266, ['cardio', 'weights', 'group_classes', 'locker_rooms', 'wifi'], '9999000001', 399, 399, '{}', '06:00', '22:00']
      );
      gymId = created.rows[0].id;
      console.log('created gym', gymId);
    }

    await cleanupGym(gymId);
    await seedGymConfig(gymId);
    await seedUsers();
    await seedSubscriptions();
    await generateBookings();
    await seedMemberCheckins();
    await seedTrainerData();
    await seedWallet();
    await seedSettlements();
    await seedAnalytics();

    await client.query('commit');
    console.log('SEED COMPLETE. gym id =', gymId);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('SEED FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function cleanupGym(g) {
  await client.query('delete from booking."Booking" where "gymId" = $1', [g]);
  await client.query('delete from booking."MemberAttendance" where "gymId" = $1', [g]);
  await client.query('delete from booking."TrainerAttendance" where "gymId" = $1', [g]);
  await client.query('delete from booking."TrainingSession" where "gymId" = $1', [g]);
  await client.query('delete from wallet."GymSubscription" where "gymId" = $1', [g]);
  await client.query('delete from wallet."PartnerBankSettlement" where "gymId" = $1', [g]);
  await client.query('delete from gym."GymSlotPrice" where "gymId" = $1', [g]);
  await client.query('delete from gym."GymOperatingHours" where "gymId" = $1', [g]);
  await client.query('delete from gym."GymClass" where "gymId" = $1', [g]);
  await client.query(`delete from wallet."WalletTransaction" where "gymId" = $1 and "idempotencyKey" like 'seed-p9-%'`, [g]);
  await client.query("delete from analytics_events where properties->>'gym_id' = $1", [String(g)]);
  console.log('cleaned demo rows scoped to gym', g);
}

async function seedGymConfig(g) {
  const times = [];
  for (let h = 6; h <= 21; h++) {
    times.push({ start: hhmm(h, 0), end: hhmm(h + 1, 0), price: sessionPrice(h) });
  }
  let vals = times.map((t, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4},now(),now())`).join(',');
  let params = times.flatMap((t) => [g, t.start, t.end, t.price]);
  await client.query(
    `insert into gym."GymSlotPrice" ("gymId","startTime","endTime","price","createdAt","updatedAt") values ${vals}`,
    params
  );

  vals = [];
  params = [];
  for (let d = 0; d < 7; d++) {
    vals.push(`($${d * 7 + 1},$${d * 7 + 2},$${d * 7 + 3},$${d * 7 + 4},$${d * 7 + 5},$${d * 7 + 6},$${d * 7 + 7})`);
    params.push(g, d, '06:00', '12:00', '16:00', '22:00', nowIso());
  }
  await client.query(
    `insert into gym."GymOperatingHours" ("gymId","dayOfWeek","morningStart","morningEnd","eveningStart","eveningEnd","updatedAt") values ${vals}`,
    params
  );

  const classes = [
    { name: 'Power Yoga', desc: 'Vinyasa flow to kickstart the day', instructor: 'Coach Meera', day: 1, start: '07:00', end: '08:00', capacity: 15, price: 249 },
    { name: 'HIIT Blast', desc: '30-minute high-intensity intervals', instructor: 'Coach Sunil', day: 3, start: '19:00', end: '20:00', capacity: 12, price: 299 },
    { name: 'Functional Strength', desc: 'Full-body barbell work', instructor: 'Coach Sunil', day: 5, start: '08:00', end: '09:00', capacity: 15, price: 249 },
    { name: 'Boxing Basics', desc: 'Footwork, pads and combos', instructor: 'Coach Daniel', day: 6, start: '10:00', end: '11:00', capacity: 10, price: 349 },
  ];
  const now = new Date();
  vals = classes.map((c, i) => `($${i * 12 + 1},$${i * 12 + 2},$${i * 12 + 3},$${i * 12 + 4},$${i * 12 + 5},$${i * 12 + 6},$${i * 12 + 7},$${i * 12 + 8},$${i * 12 + 9},$${i * 12 + 10},$${i * 12 + 11},$${i * 12 + 12})`).join(',');
  params = classes.flatMap((c) => [g, c.name, c.desc, c.instructor, c.day, c.start, c.end, c.capacity, c.price, true, now, now]);
  await client.query(
    `insert into gym."GymClass" ("gymId","name","description","instructor","dayOfWeek","startTime","endTime","capacity","price","isActive","createdAt","updatedAt") values ${vals}`,
    params
  );
  console.log('gym config seeded');
}

async function seedUsers() {
  const newUsers = [];
  MEMBERS.forEach((m) => newUsers.push({ kind: 'linked', name: m.name, phone: m.phone, leaderboard: m.leaderboard }));
  WALKINS.forEach((w) => newUsers.push({ kind: 'walkin', name: w.name, phone: w.phone }));
  TRAINERS.forEach((t) => newUsers.push({ kind: 'trainer', name: t.name, phone: t.phone }));

  const phones = newUsers.map((u) => u.phone);
  await client.query('delete from auth."User" where phone = any($1::text[])', [phones]);

  const now = new Date();
  const createdAt = (u) => new Date(now.getTime() - (u.kind === 'trainer' ? 60 : 45) * 86400000);

  const linked = newUsers.filter((u) => u.kind === 'linked');
  const walkins = newUsers.filter((u) => u.kind === 'walkin');
  const trainers = newUsers.filter((u) => u.kind === 'trainer');

  const res = [];
  for (const [group, gymColumn, extraCol] of [
    [linked, '"linkedGymId"', null],
    [walkins, '"linkedGymId"', null],
    [trainers, '"trainerGymId"', '"name","phone","email","password","role","type","isActive","fitnessGoals","profileImageUrl","fcmToken","createdAt","updatedAt"'],
  ]) {
    if (group.length === 0) continue;
    const vals = [];
    const params = [];
    group.forEach((u, i) => {
      const k = i * (extraCol ? 13 : 16);
      if (extraCol) {
        vals.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5}::auth."Role",$${k + 6}::auth."UserType",$${k + 7},$${k + 8}::auth."FitnessGoal"[],$${k + 9},$${k + 10},$${k + 11},$${k + 12},$${k + 13})`);
        params.push(u.name, u.phone, `${u.phone}@demo.local`, 'seed', 'trainer', 'general', true, '{}', '', '', createdAt(u), createdAt(u), gymId);
        return;
      }
      vals.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5}::auth."Role",$${k + 6}::auth."UserType",$${k + 7},$${k + 8}::auth."FitnessGoal"[],$${k + 9}::auth."ExperienceLevel",$${k + 10}::auth."FrequencyIntent",$${k + 11},$${k + 12},$${k + 13},$${k + 14},$${k + 15},$${k + 16})`);
      params.push(u.name, u.phone, `${u.phone}@demo.local`, 'seed', 'customer', 'general', true, '{}', 'experienced', 'three_four', '', '', u.kind === 'linked' ? u.leaderboard : false, createdAt(u), createdAt(u), u.kind === 'linked' ? gymId : null);
    });
    const cols = extraCol || '"name","phone","email","password","role","type","isActive","fitnessGoals","experienceLevel","weeklyFrequencyIntent","profileImageUrl","fcmToken","leaderboardOptIn","createdAt","updatedAt"';
    const insert = await client.query(
      `insert into auth."User" (${cols}, ${gymColumn}) values ${vals.join(',')} returning id, phone, role, "linkedGymId", "trainerGymId"`,
      params
    );
    res.push(...insert.rows);
  }

  for (const row of res) {
    if (row.role === 'trainer') trainerRows.push(row);
    else if (row.linkedGymId != null) linkedMembers.push(row);
    else walkinRows.push(row);
  }

  const e2e = linkedMembers.find((m) => m.phone === E2E_CUSTOMER.phone);
  if (!e2e) {
    const up = await client.query(
      `update auth."User" set "linkedGymId" = $1 where phone = $2 returning id, phone, role, "linkedGymId", "trainerGymId"`,
      [gymId, E2E_CUSTOMER.phone]
    );
    if (up.rows[0]) linkedMembers.push(up.rows[0]);
  }
  console.log('users seeded:', { linked: linkedMembers.length, trainers: trainerRows.length, walkins: walkinRows.length });
}

async function seedSubscriptions() {
  const now = new Date();
  const allCustomers = [...MEMBERS.map((m) => ({ phone: m.phone, plans: m.plans })), { phone: E2E_CUSTOMER.phone, plans: E2E_CUSTOMER.plans }];
  const vals = [];
  const params = [];
  let i = 0;
  for (const c of allCustomers) {
    const link = linkedMembers.find((m) => m.phone === c.phone);
    if (!link) continue;
    c.plans.forEach((plan, pi) => {
      const start = new Date(now.getTime() - plan.startedDaysAgo * 86400000);
      const end = new Date(start.getTime() + plan.duration * 86400000);
      const partnerShare = Math.round(plan.price * 0.7 * 100) / 100;
      vals.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10}::wallet."SubscriptionStatus",$${i + 11},$${i + 12},$${i + 13},$${i + 14},$${i + 15},$${i + 16},$${i + 17})`);
      params.push(link.id, gymId, partnerId, plan.planType, plan.price, 30, partnerShare, start, end, 'active', `seed-${gymId}-${link.id}-${pi}`, 'perVisit', true, 'percentage', plan.coin ? plan.coin : null, plan.coin ? Math.round(plan.coin / 5) : null, start);
      i += 17;
    });
  }
  const res = await client.query(
    `insert into wallet."GymSubscription" ("customerId","gymId","partnerId","planType","price","commissionPct","partnerShare","startDate","endDate","status","razorpayOrderId","payoutModel","isAttendanceSaas","pricingMode","coinDiscountAmount","coinDiscountCoins","createdAt")
     values ${vals.join(',')} returning id, "customerId", "planType", "endDate", "partnerShare"`,
    params
  );
  for (const row of res.rows) {
    const arr = subscriptionsByCustomer.get(row.customerId) || [];
    arr.push(row);
    subscriptionsByCustomer.set(row.customerId, arr);
  }
  console.log('subscriptions seeded:', res.rows.length);
}

function buildBooking(customerId, dayBack, hour, minute, status, isSaas, sub, opts = {}) {
  const date = istDateString(dayBack);
  const price = sessionPrice(hour);
  let partnerShare = null;
  if (sub) {
    partnerShare = perVisitShare(sub);
  } else {
    partnerShare = Math.round(price * 0.8 * 100) / 100;
  }
  const attended = status === 'completed' || status === 'started';
  const createdAt = attended ? new Date(new Date(slotIso(dayBack, hour, minute)).getTime() - 3600000) : new Date(Date.now() - dayBack * 86400000);
  return {
    customerId, gymId, date,
    startTime: hhmm(hour, minute),
    endTime: hhmm(hour + 1, minute),
    amount: price,
    commissionPct: sub ? 30 : 20,
    partnerShare,
    status,
    attendedAt: attended ? slotIso(dayBack, hour, minute) : null,
    attendanceMethod: attended ? ATTENDANCE_METHODS[(dayBack + customerId) % ATTENDANCE_METHODS.length] : null,
    attendanceVerifiedBy: attended ? partnerId : null,
    subscriptionId: sub ? sub.id : null,
    isAttendanceSaas: !!sub,
    checkinRequested: false,
    locationVerified: attended ? (opts.locationVerified ?? null) : null,
    slotShiftWarning: opts.slotShiftWarning ?? false,
    cancellationReason: status === 'cancelled' ? 'work' : null,
    nextVisitIntent: status === 'cancelled' ? 'unsure' : null,
    createdAt, updatedAt: createdAt,
  };
}

async function generateBookings() {
  const generated = [];
  const allCustomers = linkedMembers.map((m) => {
    const src = MEMBERS.find((x) => x.phone === m.phone) || E2E_CUSTOMER;
    return { id: m.id, weekdays: src.weekdays, hour: src.hour, minute: src.minute, vari: !!src.vari };
  });

  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const curHour = Math.min(20, Math.max(7, nowIST.getUTCHours()));
  const forcedLive = new Set();
  linkedMembers.slice(0, 4).forEach((m) => {
    const c = allCustomers.find((x) => x.id === m.id);
    if (c && c.weekdays.includes(istWeekday(0))) forcedLive.add(m.id);
  });
  if (forcedLive.size < 2) {
    allCustomers.forEach((c) => { if (forcedLive.size < 2 && c.weekdays.includes(istWeekday(0))) forcedLive.add(c.id); });
  }

  for (const c of allCustomers) {
    const sub = primarySub(c.id);
    for (let dayBack = HISTORY_DAYS - 1; dayBack > 0; dayBack--) {
      if (!c.weekdays.includes(istWeekday(dayBack))) continue;
      if ((dayBack * 31 + c.id) % 11 === 0) continue;
      let hour = c.hour;
      let minute = c.minute;
      if (c.vari && (dayBack + c.id) % 3 === 0) {
        hour = [17, 18, 19][dayBack % 3];
        minute = 0;
      } else if ((dayBack + c.id) % 5 === 0) {
        minute = minute + 15 >= 60 ? 10 : minute + 15;
      }
      if ((dayBack + c.id) % 23 === 0 && dayBack > 3) {
        generated.push(buildBooking(c.id, dayBack, hour, minute, 'cancelled', true, sub));
        continue;
      }
      generated.push(buildBooking(c.id, dayBack, hour, minute, 'completed', true, sub));
    }
    if (c.weekdays.includes(istWeekday(0))) {
      const live = forcedLive.has(c.id);
      generated.push(buildBooking(c.id, 0, live ? curHour : c.hour, live ? nowIST.getUTCMinutes() : c.minute, 'started', true, sub));
    }
  }

  for (const w of walkinRows) {
    const src = WALKINS.find((x) => x.phone === w.phone);
    let count = 0;
    for (let dayBack = 42; dayBack > 0 && count < 14; dayBack--) {
      if (!src.weekdays.includes(istWeekday(dayBack))) continue;
      if ((dayBack * 17 + w.id) % 9 === 0) continue;
      generated.push(buildBooking(w.id, dayBack, src.hour, src.minute, 'completed', false, null));
      count++;
    }
  }

  let futureCount = 0;
  for (let dayForward = 1; dayForward <= 3 && futureCount < 8; dayForward++) {
    const dayBack = -dayForward;
    for (const c of allCustomers) {
      if (futureCount >= 8) break;
      if (!c.weekdays.includes(istWeekday(dayBack))) continue;
      generated.push(buildBooking(c.id, dayBack, c.hour, c.minute, 'confirmed', true, primarySub(c.id)));
      futureCount++;
    }
  }

  const BATCH = 200;
  for (let i = 0; i < generated.length; i += BATCH) {
    const chunk = generated.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    chunk.forEach((b, j) => {
      const k = j * 21;
      vals.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7},$${k + 8},$${k + 9}::booking."BookingStatus",$${k + 10},$${k + 11}::booking."AttendanceMethod",$${k + 12},$${k + 13},$${k + 14},$${k + 15},$${k + 16},$${k + 17},$${k + 18}::booking."CancellationReason",$${k + 19}::booking."NextVisitIntent",$${k + 20},$${k + 21})`);
      params.push(
        b.customerId, b.gymId, b.date, b.startTime, b.endTime, b.amount, b.commissionPct, b.partnerShare,
        b.status, b.attendedAt, b.attendanceMethod, b.attendanceVerifiedBy, b.subscriptionId, b.isAttendanceSaas,
        b.checkinRequested, b.locationVerified, b.slotShiftWarning, b.cancellationReason, b.nextVisitIntent,
        b.createdAt, b.updatedAt
      );
    });
    const res = await client.query(
      `insert into booking."Booking" ("customerId","gymId","date","startTime","endTime","amount","commissionPct","partnerShare","status","attendedAt","attendanceMethod","attendanceVerifiedBy","subscriptionId","isAttendanceSaas","checkinRequested","locationVerified","slotShiftWarning","cancellationReason","nextVisitIntent","createdAt","updatedAt")
       values ${vals.join(',')} returning id, "customerId", "date", status, "isAttendanceSaas", amount, "partnerShare", "subscriptionId", "attendedAt"`,
      params
    );
    bookings = bookings.concat(res.rows);
  }
  console.log('bookings seeded:', bookings.length);
}

async function seedMemberCheckins() {
  const now = new Date();
  const extra = [];
  const linkedIds = linkedMembers.map((m) => m.id);
  for (const cid of linkedIds) {
    for (let dayBack = 40; dayBack >= 0; dayBack -= 2) {
      if (rnd() > 0.25) continue;
      const wd = istWeekday(dayBack);
      const hasBooking = bookings.some((b) => b.customerId === cid && b.date === istDateString(dayBack));
      if (hasBooking) continue;
      if (wd === 0 || wd === 6) continue;
      extra.push({ customerId: cid, gymId, date: istDateString(dayBack), checkedInAt: slotIso(dayBack, 17, 0) });
    }
  }
  if (extra.length > 0) {
    const vals = extra.map((e, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',');
    const params = extra.flatMap((e) => [e.customerId, e.gymId, e.date, e.checkedInAt]);
    await client.query(
      `insert into booking."MemberAttendance" ("customerId","gymId","date","checkedInAt") values ${vals} on conflict ("customerId","gymId","date") do nothing`,
      params
    );
  }
  console.log('extra member check-ins seeded:', extra.length);
}

async function seedTrainerData() {
  const attendanceVals = [];
  const attendanceParams = [];
  let i = 0;
  for (const t of trainerRows) {
    const src = TRAINERS.find((x) => x.phone === t.phone);
    for (let dayBack = 40; dayBack >= 1; dayBack--) {
      if (!src.weekdays.includes(istWeekday(dayBack))) continue;
      if ((dayBack * 7 + t.id) % 10 === 0) continue;
      attendanceVals.push(`($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`);
      attendanceParams.push(t.id, gymId, istDateString(dayBack), slotIso(dayBack, src.hour, 0), 'qr_geofence_self');
      i++;
    }
  }
  if (attendanceVals.length > 0) {
    await client.query(
      `insert into booking."TrainerAttendance" ("trainerId","gymId","date","checkedInAt",method) values ${attendanceVals.join(',')} on conflict ("trainerId","date") do nothing`,
      attendanceParams
    );
  }
  console.log('trainer attendance seeded:', attendanceVals.length);

  let k = 0;
  const sessions = [];
  const completeSaas = bookings.filter((b) => b.status === 'completed' && b.isAttendanceSaas && b.date >= istDateString(45));
  for (const b of completeSaas.slice(0, 120)) {
    const trainerId = trainerRows[k % trainerRows.length].id;
    sessions.push({ bookingId: b.id, trainerId, gymId, customerId: b.customerId });
    k++;
  }
  if (sessions.length > 0) {
    const sv = sessions.map((s, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4},now())`).join(',');
    const sp = sessions.flatMap((s) => [s.bookingId, s.trainerId, s.gymId, s.customerId]);
    await client.query(
      `insert into booking."TrainingSession" ("bookingId","trainerId","gymId","customerId","createdAt") values ${sv} on conflict ("bookingId") do nothing`,
      sp
    );
  }
  console.log('training sessions seeded:', sessions.length);
}

async function seedWallet() {
  const wres = await client.query(
    `insert into wallet."Wallet" ("userId","userType","balance","currency","status","createdAt","updatedAt")
     values ($1,'partner',0,'INR','active'::wallet."WalletStatus",now(),now())
     on conflict ("userId") do update set "userType"='partner', "updatedAt"=now()
     returning id`,
    [partnerId]
  );
  const walletId = wres.rows[0].id;

  const market = bookings.filter((b) => b.status === 'completed' && !b.isAttendanceSaas);
  const marketNet = market.reduce((s, b) => s + Number(b.partnerShare), 0);
  const balance = Math.round((5000 + marketNet - 1200) * 100) / 100;

  const txs = [
    { type: 'topup', amount: 5000, desc: 'Razorpay top-up ₹5000', daysAgo: 40 },
    { type: 'credit', amount: Math.round(marketNet * 0.45 * 100) / 100, desc: 'Marketplace payouts (last 30 days)', daysAgo: 30 },
    { type: 'credit', amount: Math.round(marketNet * 0.35 * 100) / 100, desc: 'Marketplace payouts (days 31-55)', daysAgo: 12 },
    { type: 'credit', amount: Math.round(marketNet * 0.2 * 100) / 100, desc: 'Marketplace payouts (days 56-60)', daysAgo: 2 },
    { type: 'bonus', amount: 20, desc: 'Bharat bonus', daysAgo: 25 },
    { type: 'withdrawal', amount: 1200, desc: 'Bank withdrawal', daysAgo: 18 },
  ];

  const vals = [];
  const params = [];
  txs.forEach((tx, i) => {
    vals.push(`($${i * 8 + 1},$${i * 8 + 2}::wallet."TransactionType",$${i * 8 + 3},$${i * 8 + 4},$${i * 8 + 5}::wallet."TransactionStatus",$${i * 8 + 6},$${i * 8 + 7},$${i * 8 + 8})`);
    params.push(
      walletId, tx.type, tx.amount, 'INR', 'success', tx.desc, gymId,
      new Date(Date.now() - tx.daysAgo * 86400000)
    );
  });
  await client.query(
    `insert into wallet."WalletTransaction" ("walletId","type",amount,currency,status,description,"gymId","createdAt")
     values ${vals.join(',')}`,
    params
  );

  await client.query('update wallet."Wallet" set balance = $1, "updatedAt" = now() where id = $2', [balance, walletId]);
  console.log('partner wallet seeded, balance', balance, 'tx:', txs.length);
}

async function seedSettlements() {
  const monthKey = (iso) => iso.slice(0, 7);
  const buckets = new Map();
  for (const b of bookings) {
    if (b.status !== 'completed' || !b.isAttendanceSaas || !b.attendedAt) continue;
    const key = monthKey(new Date(b.attendedAt).toISOString());
    if (!buckets.has(key)) buckets.set(key, new Map());
    const byCust = buckets.get(key);
    const cur = byCust.get(b.customerId) || { sum: 0, subId: null, firstBookingId: null };
    cur.sum += Number(b.partnerShare);
    cur.subId = cur.subId || b.subscriptionId;
    cur.firstBookingId = cur.firstBookingId || b.id;
    byCust.set(b.customerId, cur);
  }

  const vals = [];
  const params = [];
  let i = 0;
  const now = new Date();
  for (const [mkey, byCust] of buckets) {
    const future = mkey >= nowIso().slice(0, 7);
    for (const [cid, agg] of byCust) {
      const settledAt = future ? null : new Date(now.getTime() - (nowIso().slice(0, 7) === mkey ? 4 : 25) * 86400000);
      if (settledAt && settledAt > now) settledAt.setDate(settledAt.getDate() - 2);
      vals.push(`($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`);
      params.push(partnerId, gymId, agg.firstBookingId, agg.subId, Math.round(agg.sum * 100) / 100, settledAt, now);
      i++;
    }
  }
  if (vals.length > 0) {
    await client.query(
      `insert into wallet."PartnerBankSettlement" ("partnerId","gymId","bookingId","subscriptionId",amount,"settledAt","createdAt") values ${vals.join(',')}`,
      params
    );
  }
  console.log('bank settlements seeded:', vals.length);
}

async function seedAnalytics() {
  const events = [];
  const now = new Date();
  for (const b of bookings) {
    const custId = String(b.customerId);
    const date = b.date;
    const iso = new Date(`${date}T12:00:00+05:30`);
    const viewTs = new Date(iso.getTime() - (2 + Math.floor(rnd() * 3)) * 86400000);
    const tapTs = new Date(iso.getTime() - 86400000);
    if (viewTs < now) {
      events.push({ event: 'gym_viewed', distinct_id: custId, properties: { gym_id: String(gymId) }, ts: viewTs });
    }
    if (tapTs < now && rnd() > 0.3) {
      events.push({ event: 'book_tapped', distinct_id: custId, properties: { gym_id: String(gymId) }, ts: tapTs });
    }
    const confirmTs = new Date(iso.getTime() + 3600000);
    if (confirmTs < now) {
      events.push({ event: 'booking_confirmed', distinct_id: custId, properties: { gym_id: String(gymId), amount: Number(b.amount) }, ts: confirmTs });
    }
  }

  const BATCH = 300;
  for (let i = 0; i < events.length; i += BATCH) {
    const chunk = events.slice(i, i + BATCH);
    const vals = [];
    const params = [];
    chunk.forEach((e, j) => {
      const k = j * 6;
      vals.push(`($${k + 1},$${k + 2},$${k + 3}::jsonb,$${k + 4},$${k + 5},$${k + 6})`);
      params.push(e.event, e.distinct_id, JSON.stringify(e.properties), 'seed', 'seed', e.ts);
    });
    await client.query(
      `insert into analytics_events (event,"distinct_id",properties,source,service,ts) values ${vals.join(',')}`,
      params
    );
  }
  console.log('analytics events seeded:', events.length);
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});