import express from 'express';
import dotenv from 'dotenv';
import { extractUser } from './middleware/requireAuth.js';
import walletRoutes from './routes/wallet.js';
import { pool } from './db.js';
import { reconcilePendingRazorpayOrdersService } from './services/walletService.js';

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

// Periodic Razorpay top-up reconciliation (every 5 min while the container is
// warm). Cloud Run throttles CPU between requests by default, so this timer is
// a best-effort convenience, NOT a correctness guarantee — the same settle
// logic also runs lazily whenever a customer reads their wallet (see
// getMyWallet/getMyWalletTransactions), which is the true backstop. It makes
// the dashboard webhook optional: a top-up where the app was killed before the
// client-side /verify ran still lands on the next sweep or the customer's next
// wallet visit. No-op fast when there are no stale PENDING orders.
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_SECRET) {
  setInterval(() => {
    reconcilePendingRazorpayOrdersService().catch((err) =>
      console.error('Razorpay reconcile sweep error:', err.message)
    );
  }, 5 * 60 * 1000);
}