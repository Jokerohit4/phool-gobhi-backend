import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import { PrismaClient } from '@prisma/client';
import authRoutes from './routes/auth.js';

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(express.json());

// Routes
app.use('/', authRoutes);

app.get('/health', (req, res) => res.json({ status: 'Auth Service is healthy' }));

// Debug endpoint to test database connection
app.get('/debug/db-test', async (req, res) => {
  try {
    const userCount = await prisma.user.count();
    res.json({ 
      status: 'Database connected', 
      userCount,
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
const PORT = process.env.AUTH_SERVICE_PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Auth Service running on port ${PORT}`);
}); 