// How the entrance check-in tells a guest about the booking they already have:
// "Your session is tomorrow at 7:00 PM." Pure, so the wording is tested without a
// database. Dates are IST calendar-date strings (YYYY-MM-DD), like everywhere else
// in booking-service.

import { formatSlotTime, getDayOfWeek } from './slotTiming.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole calendar days from `today` to `date` (0 = today, 1 = tomorrow). */
export function daysFromToday(today, date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
}

/** "today", "tomorrow", or "on Friday 14 Nov". */
export function whenPhrase(days, date) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const [, month, day] = date.split('-').map(Number);
  return `on ${WEEKDAYS[getDayOfWeek(date)]} ${day} ${MONTHS[month - 1]}`;
}

/** The booking as the client needs it, with how far away it is. */
export function shapeUpcomingBooking(booking, today) {
  return {
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    status: booking.status,
    daysFromToday: daysFromToday(today, booking.date),
  };
}

/** "Your session is tomorrow at 7:00 PM." */
export function describeUpcomingBooking(booking) {
  return `Your session is ${whenPhrase(booking.daysFromToday, booking.date)} at ${formatSlotTime(booking.startTime)}.`;
}
