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
app.use('/', bookingRoutes);

app.get('/health', (req, res) => res.json({ status: 'Booking Service is healthy' }));

app.get('/debug/db-test', async (req, res) => {
  try {
    const bookingCount = await prisma.booking.count();
    res.json({
      status: 'Database connected',
      bookingCount,
      message: 'Prisma client is working correctly'
    });
  } catch (err) {
    res.status(500).json({
      error: 'Database connection failed',
      details: {
        code: err.code,
        message: err.message,
        name: err.name,
      }
    });
  }
});

const PORT = process.env.BOOKING_SERVICE_PORT || 5005;
app.listen(PORT, () => console.log(`Booking Service running on port ${PORT}`));
