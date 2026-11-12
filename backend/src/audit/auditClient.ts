import 'dotenv/config';
import { env } from '../config/env';

export interface AuditEvent {
  usuario_id: number | null;
  acao: string;
  servico: 'catalogo' | 'auth-service';
  recurso?: string;
  resultado: 'sucesso' | 'negado' | 'erro';
  ip?: string;
  detalhe?: Record<string, string | number | boolean>;
}

export function audit(evento: Omit<AuditEvent, 'servico'>): void {
  try {
    const payload: AuditEvent = {
      ...evento,
      servico: 'catalogo'
    };

    fetch(`${env.LOG_SERVICE_URL}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': env.INTERNAL_SERVICE_TOKEN
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500)
    }).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); }).catch(err => {
      // Falha silenciosamente (não derruba a aplicação), de acordo com ADR-004
      console.warn(`[Audit] Falha ao enviar evento ${evento.acao}: ${err.message}`);
    });
  } catch (err: any) {
    console.warn(`[Audit] Erro síncrono ao serializar/preparar evento ${evento.acao}: ${err.message}`);
  }
}
