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
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'Gym Service is healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Routes
app.use('/', gymRoutes);

// Global error handler — catches anything a route/middleware passes to
// next(err) instead of handling itself (e.g. Multer's file-too-large error),
// so upload failures return the same JSON shape as every other error path
// instead of falling through to Express's default HTML response. Cloudinary
// upload failures are caught inline in the controllers instead (see
// utils/upload.js's retry wrapper) and never reach here.
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large (max 10 MB)' });
  }
  console.error('Unhandled error:', err);
  res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
});

// Start server
const PORT = process.env.PORT || process.env.GYM_SERVICE_PORT || 5004;
app.listen(PORT, () => {
  console.log(`Gym Service running on port ${PORT}`);
});
