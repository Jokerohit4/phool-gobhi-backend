// Daily reminder schedule (IST) and copy for the water / meal / workout pushes.
// Pure data + functions so the exact slots and wording can be reviewed and tested
// without a database or Firebase.
//
// Water is four pushes a day (half of the previous eight, cut because users found
// it too much). Every water push is more than an hour from every meal push, so a
// water nudge never lands right before or after a meal nudge. Meal pushes no longer
// carry a water line.
//
//   07:00 workout            08:00 water            10:00 breakfast
//   11:30 water              14:00 lunch            15:30 water
//   17:30 workout            18:00 snack            19:30 water
//   21:30 dinner

export const TOLERANCE_MINUTES = 10; // a slot is "due" for this long after its time

export const SLOTS = [
  { time: '07:00', workout: true },
  { time: '08:00', water: true, first: true },
  { time: '10:00', meal: 'breakfast' },
  { time: '11:30', water: true },
  { time: '14:00', meal: 'lunch' },
  { time: '15:30', water: true },
  { time: '17:30', workout: true },
  { time: '18:00', meal: 'snack' },
  { time: '19:30', water: true },
  { time: '21:30', meal: 'dinner' },
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
  breakfast: { title: 'Breakfast time \u{1F373}', body: 'Log your meal to keep your day on track.' },
  lunch: { title: 'Lunch time \u{1F37D}\u{FE0F}', body: 'Log your meal to keep your day on track.' },
  snack: { title: 'Snack time \u{1F34E}', body: 'Pick something light and log it.' },
  dinner: { title: 'Dinner time \u{1F372}', body: 'Log your dinner to wrap up the day.' },
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
      body: copy.body,
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
