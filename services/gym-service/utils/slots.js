export function generateTimeSlots(openTime, closeTime, slotDuration) {
  const slots = [];
  const [openHour, openMin] = openTime.split(':').map(Number);
  const [closeHour, closeMin] = closeTime.split(':').map(Number);
  let current = openHour * 60 + openMin;
  const end = closeHour * 60 + closeMin;
  while (current + slotDuration <= end) {
    const startH = Math.floor(current / 60).toString().padStart(2, '0');
    const startM = (current % 60).toString().padStart(2, '0');
    const endMin = current + slotDuration;
    const endH = Math.floor(endMin / 60).toString().padStart(2, '0');
    const endM = (endMin % 60).toString().padStart(2, '0');
    slots.push({ startTime: `${startH}:${startM}`, endTime: `${endH}:${endM}` });
    current += slotDuration;
  }
  return slots;
}

// Slots for a single day, given that day's GymOperatingHours row (up to two
// windows — morning + evening; either may be null meaning no window that
// side of the day, e.g. a midday gap or a day closed entirely).
export function generateWindowedSlots(hoursRow, slotDuration) {
  const slots = [];
  if (hoursRow?.morningStart && hoursRow?.morningEnd) {
    slots.push(...generateTimeSlots(hoursRow.morningStart, hoursRow.morningEnd, slotDuration));
  }
  if (hoursRow?.eveningStart && hoursRow?.eveningEnd) {
    slots.push(...generateTimeSlots(hoursRow.eveningStart, hoursRow.eveningEnd, slotDuration));
  }
  return slots;
}
