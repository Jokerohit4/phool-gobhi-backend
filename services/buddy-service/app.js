import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from './db.js';
connectDB();
import express from 'express';
import { PrismaClient } from '@prisma/client';
import buddyRoutes from './routes/buddy.js';

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(express.json());

// Health must be registered before the router: buddyRoutes is mounted at
// '/' and its param routes (e.g. DELETE /photos/:photoId) could otherwise
// shadow /health — same ordering bug class gym-service hit in production.
// (CI pipeline validation touch — confirms a normal deploy after the
// rollback-fix change correctly claims 100% traffic without manual help.)
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'Buddy Service is healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Routes
app.use('/', buddyRoutes);

// Global error handler — catches anything a route/middleware passes to
// next(err) instead of handling itself (e.g. Multer's file-too-large error),
// so upload failures return the same JSON shape as every other error path
// instead of falling through to Express's default HTML response.
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Photo is too large (max 8 MB)' });
  }
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Too many photos in one upload (max 6)' });
  }
  console.error('Unhandled error:', err);
  res.status(err?.status || 500).json({ error: err?.message || 'Server error' });
});

// Start server
const PORT = process.env.PORT || process.env.BUDDY_SERVICE_PORT || 5007;
app.listen(PORT, () => {
  console.log(`Buddy Service running on port ${PORT}`);
});
