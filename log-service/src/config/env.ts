import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.INTERNAL_SERVICE_TOKEN) {
  throw new Error('INTERNAL_SERVICE_TOKEN não definido');
}

export const env = {
  PORT: process.env.LOG_PORT || 3002,
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  AUDIT_STREAM_MAXLEN: parseInt(process.env.AUDIT_STREAM_MAXLEN || '10000', 10),
  INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN
};
