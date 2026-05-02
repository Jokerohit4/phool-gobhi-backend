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
