import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.on('connection', connection => { connection.query("SET time_zone = '+00:00'"); });

export default pool;
