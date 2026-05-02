// db.js
import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false,
});

const connectDB = async () => {
  try {
    await pool.connect();
    console.log('✅ PostgreSQL (Supabase) connected');
  } catch (err) {
    console.error('❌ PostgreSQL connection error:', err.message);
    process.exit(1);
  }
};

export { pool, connectDB };