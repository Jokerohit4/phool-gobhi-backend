// Daily reminder schedule (IST) and copy for the water / meal / workout pushes.
// Pure data + functions so the exact slots and wording can be reviewed and tested
// without a database or Firebase.
//
// Slots are bundled: when a water reminder and a meal reminder fall at the same
// time they go out as ONE push (see buildSlotMessage), so the day is 11 pushes,
// not 14.
//
//   07:00 workout            08:00 water            10:00 breakfast + water
//   12:00 water              14:00 lunch + water     16:00 water
//   17:30 workout            18:00 snack + water     20:00 water
//   21:30 dinner             22:00 water

export const TOLERANCE_MINUTES = 10; // a slot is "due" for this long after its time

export const SLOTS = [
  { time: '07:00', workout: true },
  { time: '08:00', water: true, first: true },
  { time: '10:00', meal: 'breakfast', water: true },
  { time: '12:00', water: true },
  { time: '14:00', meal: 'lunch', water: true },
  { time: '16:00', water: true },
  { time: '17:30', workout: true },
  { time: '18:00', meal: 'snack', water: true },
  { time: '20:00', water: true },
  { time: '21:30', meal: 'dinner' },
  { time: '22:00', water: true, last: true },
];

const minutesOf = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export function istMinutes(now = new Date()) {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// The slot whose time is within the last TOLERANCE_MINUTES, or null.
export function findDueSlot(now = new Date(), slots = SLOTS) {
  const m = istMinutes(now);
  return slots.find((s) => m - minutesOf(s.time) >= 0 && m - minutesOf(s.time) < TOLERANCE_MINUTES) ?? null;
}

export function findSlotByTime(time, slots = SLOTS) {
  return slots.find((s) => s.time === time) ?? null;
}

const MEAL_COPY = {
  breakfast: { title: 'Breakfast time \u{1F373}', withWater: 'Log your meal and have a glass of water \u{1F4A7}.', plain: 'Log your meal to keep your day on track.' },
  lunch: { title: 'Lunch time \u{1F37D}\u{FE0F}', withWater: 'Log your meal and have a glass of water \u{1F4A7}.', plain: 'Log your meal to keep your day on track.' },
  snack: { title: 'Snack time \u{1F34E}', withWater: 'Pick something light, log it, and drink some water \u{1F4A7}.', plain: 'Pick something light and log it.' },
  dinner: { title: 'Dinner time \u{1F372}', withWater: 'Log your dinner and have a glass of water \u{1F4A7}.', plain: 'Log your dinner to wrap up the day.' },
};

// enabled = { water, meal, workout } booleans (per-category kill switches).
// Returns null when nothing in the slot is enabled. Otherwise the push to send:
//   { title, body, data:{type, route?}, pushType }
// Meal pushes use the existing `health_nudge` / `quick_log` routing so a tap opens
// the health dashboard in current app builds; water and workout pushes use their
// own types, which current builds treat as "just open the app" (Home, whose first
// card is the water step).
export function buildSlotMessage(slot, enabled) {
  const water = Boolean(slot.water && enabled.water);
  const meal = slot.meal && enabled.meal ? slot.meal : null;
  const workout = Boolean(slot.workout && enabled.workout);

  if (meal) {
    const copy = MEAL_COPY[meal];
    return {
      title: copy.title,
      body: water ? copy.withWater : copy.plain,
      data: { type: 'health_nudge', route: 'quick_log' },
      pushType: `meal_reminder:${meal}`,
    };
  }
  if (water) {
    if (slot.first) {
      return {
        title: 'Good morning \u{1F4A7}',
        body: 'Start your day with a glass of water.',
        data: { type: 'water_reminder' },
        pushType: 'water_reminder',
      };
    }
    if (slot.last) {
      return {
        title: 'Last glass of the day \u{1F4A7}',
        body: 'Wind down with a glass of water.',
        data: { type: 'water_reminder' },
        pushType: 'water_reminder',
      };
    }
    return {
      title: 'Water break \u{1F4A7}',
      body: 'Time for a glass of water.',
      data: { type: 'water_reminder' },
      pushType: 'water_reminder',
    };
  }
  if (workout) {
    return {
      title: 'Time to move \u{1F4AA}',
      body: 'Even a short workout counts. Ready when you are.',
      data: { type: 'workout_reminder' },
      pushType: 'workout_reminder',
    };
  }
  return null;
}
