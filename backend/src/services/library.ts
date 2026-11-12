import type { Pool, RowDataPacket } from 'mysql2/promise';
import { getCatalogProvider, assertValidProvider } from '../providers';
import { HttpError, missing } from '../http';
import { mangadexCovers } from './mangadexCovers';

export async function ownShelf(db: Pick<Pool, 'query'>, user: number, shelf: number, lock = false): Promise<RowDataPacket> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT id, usuario_id, nome, descricao, criado_em, atualizado_em FROM estantes WHERE id=? AND usuario_id=?${lock ? ' FOR UPDATE' : ''}`, [shelf, user]);
  if (!rows[0]) throw missing();
  return rows[0];
}
export async function hydrateReferences(rows: RowDataPacket[]) {
  const metadata = new Map<string, unknown>();
  for (const provider of ['demo', 'mangadex'] as const) {
    const ids = [...new Set(rows.filter(r => r.provider === provider).map(r => String(r.manga_id)))];
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const works = await getCatalogProvider(provider).getManyMangas(ids.slice(i, i + 100));
        works.forEach((work, key) => metadata.set(`${provider}:${key}`, mangadexCovers.present(work)));
      } catch { /* Referências privadas continuam disponíveis quando a fonte falha. */ }
    }
  }
  return rows.map(row => ({ ...row, metadataAvailable: metadata.has(`${row.provider}:${row.manga_id}`), manga: metadata.get(`${row.provider}:${row.manga_id}`) ?? null }));
}
export async function currentSubscription(db: Pool, user: number) {
  const [rows] = await db.query<RowDataPacket[]>("SELECT status, acesso_ate, cancel_at_period_end, (status='active' AND acesso_ate > UTC_TIMESTAMP()) AS is_pro FROM assinaturas WHERE usuario_id=?", [user]);
  const subscription = rows[0];
  const pro = !!subscription && Number(subscription.is_pro) === 1;
  return { plano: pro ? 'pro' : 'free', isPro: pro, status: subscription?.status ?? 'none', acessoAte: subscription?.acesso_ate ?? null, cancelAtPeriodEnd: !!subscription?.cancel_at_period_end, canManageRenewal: !!subscription && ['active', 'past_due'].includes(subscription.status), capabilities: { automaticProgress: pro, demoFullReader: pro } };
}
export async function authorizeChapter(db: Pool, user: number, rawProvider: unknown, chapterId: unknown) {
  const provider = assertValidProvider(rawProvider);
  if (typeof chapterId !== 'string' || chapterId.length > 100) throw new HttpError(400, 'INVALID_EXTERNAL_ID', 'Capítulo inválido.');
  const client = getCatalogProvider(provider);
  const context = await client.getChapterContext(chapterId);
  if (context.chapter.externalUrl || context.chapter.pagesCount <= 0) throw new HttpError(422, 'EXTERNAL_CHAPTER_ONLY', 'Este capítulo não possui páginas internas disponíveis.');
  if (provider === 'demo' && !context.chapter.isEligibleForFree && !(await currentSubscription(db, user)).isPro) {
    throw new HttpError(403, 'PLAN_REQUIRED', 'Este capítulo demonstrativo requer o plano Pro.');
  }
  return { client, context, provider };
}
