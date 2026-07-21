import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import { PrismaClient } from '@prisma/client';
import authRoutes from './routes/auth.js';
import userProfileRoutes from './routes/userProfile.js';

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(express.json());

// Routes
app.use('/', authRoutes);
app.use('/users', userProfileRoutes);

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'Auth Service is healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Global error handler — catches anything a route/middleware passes to
// next(err) instead of handling itself (e.g. Multer's file-too-large error
// from the profile-picture upload, or a Cloudinary storage failure), so
// upload failures return the same JSON shape as every other error path
// instead of falling through to Express's default HTML response.
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large' });
  }
  console.error('Unhandled error:', err);
  res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
});

// Start server
const PORT = process.env.PORT || process.env.AUTH_SERVICE_PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Auth Service running on port ${PORT}`);
});
