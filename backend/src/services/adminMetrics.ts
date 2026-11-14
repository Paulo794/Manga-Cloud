import type { Pool, RowDataPacket } from 'mysql2/promise';
import { PRO_MONTHLY_PRICE_CENTS } from './library';

export interface AdminMetrics {
  totalUsuarios: number;
  usuariosPorPlano: { free: number; pro: number };
  assinaturasAtivas: number;
  assinaturasPorStatus: {
    ativas: number;
    inadimplentes: number;
    cancelamentoAgendado: number;
    canceladas: number;
  };
  precoProCentavos: number;
  mrrCentavos: number;
}

/** Calcula totais por plano, situação das assinaturas e MRR de teste no MariaDB. */
export async function getAdminMetrics(db: Pick<Pool, 'query'>): Promise<AdminMetrics> {
  const [totalRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM usuarios');
  const [subRows] = await db.query<RowDataPacket[]>(
    `SELECT
      SUM(CASE WHEN status='active' AND acesso_ate > UTC_TIMESTAMP() THEN 1 ELSE 0 END) AS proAtivas,
      SUM(CASE WHEN status IN ('past_due', 'unpaid') THEN 1 ELSE 0 END) AS inadimplentes,
      SUM(CASE WHEN status='active' AND acesso_ate > UTC_TIMESTAMP() AND cancel_at_period_end=1 THEN 1 ELSE 0 END) AS cancelamentoAgendado,
      SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceladas
    FROM assinaturas`
  );
  const totalUsuarios = Number(totalRows[0]?.total ?? 0);
  const proAtivas = Number(subRows[0]?.proAtivas ?? 0);
  return {
    totalUsuarios,
    usuariosPorPlano: { free: Math.max(0, totalUsuarios - proAtivas), pro: proAtivas },
    assinaturasAtivas: proAtivas,
    assinaturasPorStatus: {
      ativas: proAtivas,
      inadimplentes: Number(subRows[0]?.inadimplentes ?? 0),
      cancelamentoAgendado: Number(subRows[0]?.cancelamentoAgendado ?? 0),
      canceladas: Number(subRows[0]?.canceladas ?? 0)
    },
    precoProCentavos: PRO_MONTHLY_PRICE_CENTS,
    mrrCentavos: proAtivas * PRO_MONTHLY_PRICE_CENTS
  };
}
