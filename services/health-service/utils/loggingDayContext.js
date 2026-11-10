import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export function dayStartHour() { return context.getStore()?.startHour ?? 4; }
export function loggingDayMiddleware(req, res, next) {
  const raw = req.get('X-Day-Start-Hour');
  const parsed = raw == null ? 4 : Number(raw);
  const startHour = Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : 4;
  context.run({ startHour }, next);
}
