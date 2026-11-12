import { createClient } from 'redis';
import { env } from '../config/env';
import { AuditEvent } from '../types/auditEvent';

// Criamos o client apontando para a URL do Redis
const client = createClient({ url: env.REDIS_URL });

client.on('error', (err) => console.error('[Redis]', err));

export const connectRedis = async () => {
  if (!client.isOpen) {
    await client.connect();
    console.log('Log-Service conectado ao Redis Streams');
  }
};

const STREAM_KEY = 'audit:events';

export const emitEvent = async (event: AuditEvent): Promise<string> => {
  const record: Record<string, string> = {
    usuario_id: event.usuario_id === null ? 'null' : String(event.usuario_id),
    acao: event.acao,
    servico: event.servico,
    resultado: event.resultado,
  };
  
  if (event.recurso) record.recurso = event.recurso;
  if (event.ip) record.ip = event.ip;
  if (event.detalhe) record.detalhe = JSON.stringify(event.detalhe);

  const id = await client.xAdd(STREAM_KEY, '*', record, {
    TRIM: {
      strategy: 'MAXLEN',
      strategyModifier: '~',
      threshold: env.AUDIT_STREAM_MAXLEN
    }
  });

  return id;
};

export const getRecentEvents = async (limit: number): Promise<AuditEvent[]> => {
  const result = await client.xRevRange(STREAM_KEY, '+', '-', { COUNT: limit });
  
  const events = result.map(entry => {
    return {
      id: entry.id,
      timestamp: new Date(Number(entry.id.split('-')[0])).toISOString(),
      usuario_id: entry.message.usuario_id === 'null' ? null : Number(entry.message.usuario_id),
      acao: entry.message.acao,
      recurso: entry.message.recurso,
      servico: entry.message.servico,
      resultado: entry.message.resultado,
      ip: entry.message.ip,
      detalhe: entry.message.detalhe ? JSON.parse(entry.message.detalhe) : undefined
    } as AuditEvent;
  });

  return events.reverse();
};

export const checkRedisHealth = (): boolean => {
  return client.isReady;
};

export async function disconnectRedis() { if (client.isOpen) await client.quit(); }
