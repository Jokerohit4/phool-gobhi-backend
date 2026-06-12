import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import { PrismaClient } from '@prisma/client';
import gymRoutes from './routes/gym.js';

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(express.json());

// Health must be registered before the router: gymRoutes is mounted at '/'
// and its GET /:id would otherwise capture /health as a gym id.
app.get('/health', (req, res) => res.json({ status: 'Gym Service is healthy' }));

// Routes
app.use('/', gymRoutes);

// Debug endpoint to test database connection
app.get('/debug/db-test', async (req, res) => {
  try {
    const gymCount = await prisma.gym.count();
    res.json({
      status: 'Database connected',
      gymCount,
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

// Start server
const PORT = process.env.PORT || process.env.GYM_SERVICE_PORT || 5004;
app.listen(PORT, () => {
  console.log(`Gym Service running on port ${PORT}`);
});
