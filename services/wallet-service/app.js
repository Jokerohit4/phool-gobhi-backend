import './bootstrap-secrets.js';
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

// Periodic Razorpay top-up reconciliation is triggered externally now (see
// .github/workflows/reconcile-razorpay-orders.yml), not by an in-process
// setInterval as this used to do. Cloud Run throttles a container's CPU to
// near-zero between requests unless cpu-throttling is explicitly disabled
// (it isn't, for this service) — a timer firing while idle got starved of
// the CPU needed to even open a Postgres connection, missing Prisma's 10s
// pool-acquisition timeout on every single tick in both dev and prod. A
// real incoming HTTP request (POST /internal/orders/reconcile-pending)
// gets full CPU allocation the old timer never could. Still pure
// convenience, not a correctness requirement: the same settle logic also
// runs lazily whenever a customer reads their wallet (see
// getMyWallet/getMyWalletTransactions), which is the true backstop.