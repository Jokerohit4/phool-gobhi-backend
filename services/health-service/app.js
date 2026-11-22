import './bootstrap-secrets.js';
import { loggingDayMiddleware } from './utils/loggingDayContext.js';
import { analyticsMiddleware } from './utils/analyticsTransport.js';
import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import prisma from './db/prisma.js';
import healthRoutes from './routes/health.js';

const app = express();
app.use(analyticsMiddleware());

app.use(express.json());
app.use(loggingDayMiddleware);

// Health must be registered before the router — same ordering rule
// gym-service/buddy-service/challenge-service already enforce (a param
// route could otherwise shadow /health).
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'Health Service is healthy' });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(503).json({ status: 'unhealthy', error: 'Service unavailable' });
  }
});

app.use('/', healthRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  // Never leak internal detail (SQL, hostnames, stack text) on 5xx; the full
  // error is logged above. 4xx messages are intentional and kept.
  const status = err?.status || 500;
  res.status(status).json({ error: status >= 500 ? 'Server error' : (err?.message || 'Server error') });
});

const PORT = process.env.PORT || process.env.HEALTH_SERVICE_PORT || 5009;
app.listen(PORT, () => {
  console.log(`Health Service running on port ${PORT}`);
});
