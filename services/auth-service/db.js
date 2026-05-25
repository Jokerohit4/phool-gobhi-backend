// db.js
import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('pg pool error (will reconnect):', err.message);
});

const connectDB = async () => {
  try {
    const client = await pool.connect();
    client.release();
    console.log('PostgreSQL connected (auth-service)');
  } catch (err) {
    console.error('PostgreSQL connection error:', err.message);
    process.exit(1);
  }
};

export { pool, connectDB };