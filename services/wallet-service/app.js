import express from 'express';
import dotenv from 'dotenv';
import { extractUser } from './middleware/requireAuth.js';
import walletRoutes from './routes/wallet.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(extractUser);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/', walletRoutes);

const PORT = process.env.PORT || process.env.WALLET_SERVICE_PORT || 5003;
app.listen(PORT, () => {
  console.log(`🚀 Wallet Service running on port ${PORT}`);
}); 