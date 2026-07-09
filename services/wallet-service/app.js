import express from 'express';
import dotenv from 'dotenv';
import { extractUser } from './middleware/requireAuth.js';
import walletRoutes from './routes/wallet.js';
import { pool } from './db.js';

dotenv.config();

const app = express();
// Razorpay signs the exact raw bytes of the webhook payload — stash them here
// since express.json() only exposes the re-parsed object, and re-serializing
// that with JSON.stringify is not guaranteed to match byte-for-byte (key
// order, whitespace, number formatting can all differ).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(extractUser);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.use('/', walletRoutes);

const PORT = process.env.PORT || process.env.WALLET_SERVICE_PORT || 5003;
app.listen(PORT, () => {
  console.log(`🚀 Wallet Service running on port ${PORT}`);
}); 