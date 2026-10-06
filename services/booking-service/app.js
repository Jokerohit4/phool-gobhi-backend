import './bootstrap-secrets.js';
import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import { PrismaClient } from '@prisma/client';
import bookingRoutes from './routes/booking.js';

const app = express();
const prisma = new PrismaClient();

app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'Booking Service is healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.use('/', bookingRoutes);

const PORT = process.env.PORT || process.env.BOOKING_SERVICE_PORT || 5005;
app.listen(PORT, () => console.log(`Booking Service running on port ${PORT}`));
