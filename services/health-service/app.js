import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import { PrismaClient } from '@prisma/client';
import healthRoutes from './routes/health.js';

const app = express();
const prisma = new PrismaClient();

app.use(express.json());

// Health must be registered before the router — same ordering rule
// gym-service/buddy-service/challenge-service already enforce (a param
// route could otherwise shadow /health).
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'Health Service is healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.use('/', healthRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
});

const PORT = process.env.PORT || process.env.HEALTH_SERVICE_PORT || 5009;
app.listen(PORT, () => {
  console.log(`Health Service running on port ${PORT}`);
});
