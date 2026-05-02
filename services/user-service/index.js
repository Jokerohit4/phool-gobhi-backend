import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import userRoutes from './routes/user.js';

const app = express();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Middleware
app.use(express.json());

// Routes
app.use('/', userRoutes);

app.get('/health', (req, res) => res.json({ status: 'User Service is healthy' }));

// Start server
const PORT = process.env.USER_SERVICE_PORT || 5002;
app.listen(PORT, () => {
  console.log(`🚀 User Service running on port ${PORT}`);
}); 