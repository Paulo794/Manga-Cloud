import { Router } from 'express';
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { AuthRequest, makeAuthenticate } from '../middleware/authMiddleware';
import { getCatalogProvider, getDefaultCatalogProvider, assertValidProvider } from '../providers';
import { HttpError, text, pagination, missing } from '../http';
import { currentSubscription, authorizeChapter, hydrateReferences } from '../services/library';
import { requireRole } from '../middleware/requireRole';
import { audit } from '../audit/auditClient';
import { mangadexCovers } from '../services/mangadexCovers';

export function readingRouter(db: Pool, emit: typeof audit = audit) {
  const router = Router();
  router.get('/mangas/config', (_req, res) => {
    res.json({ defaultProvider: getDefaultCatalogProvider() });
  });
  router.get('/mangas', makeAuthenticate(db, true), async (req, res) => {
    const { page, limit } = pagination(req.query);
    const provider = assertValidProvider(req.query.provider, getDefaultCatalogProvider());
    const result = await getCatalogProvider(provider).searchMangas({ query: typeof req.query.q === 'string' ? req.query.q.slice(0, 150) : '', tag: typeof req.query.tag === 'string' ? req.query.tag : '', language: typeof req.query.idioma === 'string' ? req.query.idioma : 'pt-br', page, limit });
    res.json({ ...result, items: result.items.map(manga => mangadexCovers.present(manga)) });
  });
  router.get('/mangas/tags', async (req, res) => res.json(await getCatalogProvider(assertValidProvider(req.query.provider, getDefaultCatalogProvider())).getTags()));
  router.get('/mangas/mangadex/:mangaId/capa', async (req, res) => {
    const cover = await mangadexCovers.get(text(req.params.mangaId, 100, true));
    res.set('Cache-Control', 'public, max-age=300').type(cover.mime).send(cover.data);
  });
  router.get('/mangas/:provider/:mangaId', async (req, res) => res.json(mangadexCovers.present(await getCatalogProvider(assertValidProvider(req.params.provider)).getMangaById(text(req.params.mangaId, 100, true)))));
  router.get('/mangas/:provider/:mangaId/capitulos', makeAuthenticate(db, true), async (req: AuthRequest, res) => {
    const provider = assertValidProvider(req.params.provider);
    const result = await getCatalogProvider(provider).getChapters(text(req.params.mangaId, 100, true), typeof req.query.idioma === 'string' ? req.query.idioma : 'pt-br');
    const pro = req.user ? (await currentSubscription(db, req.user.id)).isPro : false;
    res.json({ ...result, chapters: result.chapters.map(ch => ({ ...ch, bloqueadoParaFree: provider === 'demo' && !ch.isEligibleForFree, liberadoParaUsuarioAtual: !!req.user && !ch.externalUrl && ch.pagesCount > 0 && (provider === 'mangadex' || ch.isEligibleForFree || pro) })) });
  });
  router.get('/leitura/:provider/:chapterId/manifesto', makeAuthenticate(db), async (req: AuthRequest, res) => {
    try {
      const { client } = await authorizeChapter(db, req.user!.id, req.params.provider, req.params.chapterId);
      const manifest = await client.getChapterManifest(text(req.params.chapterId, 100, true));
      emit({ usuario_id: req.user!.id, acao: 'leitura.liberada', recurso: `capitulo:${req.params.provider}:${req.params.chapterId}`, resultado: 'sucesso' });
      res.set('Cache-Control', 'private, no-store').json(manifest);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'PLAN_REQUIRED') emit({ usuario_id: req.user!.id, acao: 'leitura.bloqueada', recurso: `capitulo:${req.params.provider}:${req.params.chapterId}`, resultado: 'negado' });
      throw error;
    }
  });
  router.get('/assinatura', makeAuthenticate(db), async (req: AuthRequest, res) => res.json(await currentSubscription(db, req.user!.id)));
  router.get('/favoritos', makeAuthenticate(db), async (req: AuthRequest, res) => {
    const { page, limit, offset } = pagination(req.query);
    const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM favoritos_manga WHERE usuario_id=? ORDER BY criado_em DESC, id DESC LIMIT ? OFFSET ?', [req.user!.id, limit, offset]);
    const [count] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM favoritos_manga WHERE usuario_id=?', [req.user!.id]);
    res.json({ items: await hydrateReferences(rows), page, limit, total: Number(count[0]!.total) });
  });
  router.post('/favoritos', makeAuthenticate(db), async (req: AuthRequest, res) => {
    const provider = assertValidProvider(req.body?.provider), mangaId = text(req.body?.mangaId, 100, true);
    await getCatalogProvider(provider).getMangaById(mangaId);
    const [result] = await db.query<ResultSetHeader>('INSERT INTO favoritos_manga (usuario_id, provider, manga_id) VALUES (?, ?, ?)', [req.user!.id, provider, mangaId]);
    emit({ usuario_id: req.user!.id, acao: 'favorito.adicionado', recurso: `manga:${provider}:${mangaId}`, resultado: 'sucesso' });
    res.status(201).json({ id: result.insertId });
  });
  router.delete('/favoritos/:provider/:mangaId', makeAuthenticate(db), async (req: AuthRequest, res) => {
    const provider = assertValidProvider(req.params.provider), mangaId = text(req.params.mangaId, 100, true);
    const [result] = await db.query<ResultSetHeader>('DELETE FROM favoritos_manga WHERE usuario_id=? AND provider=? AND manga_id=?', [req.user!.id, provider, mangaId]);
    if (!result.affectedRows) throw missing();
    emit({ usuario_id: req.user!.id, acao: 'favorito.removido', recurso: `manga:${provider}:${mangaId}`, resultado: 'sucesso' });
    res.sendStatus(204);
  });
  router.get('/progresso', makeAuthenticate(db), async (req: AuthRequest, res) => {
    const { page, limit, offset } = pagination(req.query);
    const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM progresso_leitura WHERE usuario_id=? ORDER BY atualizado_em DESC, id DESC LIMIT ? OFFSET ?', [req.user!.id, limit, offset]);
    const [count] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM progresso_leitura WHERE usuario_id=?', [req.user!.id]);
    res.json({ items: await hydrateReferences(rows), page, limit, total: Number(count[0]!.total) });
  });
  router.get('/progresso/:provider/:mangaId', makeAuthenticate(db), async (req: AuthRequest, res) => {
    const provider = assertValidProvider(req.params.provider), mangaId = text(req.params.mangaId, 100, true);
    const language = typeof req.query.idioma === 'string' ? text(req.query.idioma, 16, true) : 'pt-br';
    const [rows] = await db.query<RowDataPacket[]>('SELECT chapter_id, pagina, total_paginas, revisao, idioma FROM progresso_leitura WHERE usuario_id=? AND provider=? AND manga_id=? AND idioma=?', [req.user!.id, provider, mangaId, language]);
    if (!rows[0]) throw missing();
    res.json(rows[0]);
  });
  router.put('/progresso/:provider/:mangaId', makeAuthenticate(db), async (req: AuthRequest, res) => {
    if (!(await currentSubscription(db, req.user!.id)).isPro) throw new HttpError(403, 'PLAN_REQUIRED', 'O progresso automático está disponível no Pro.');
    const provider = assertValidProvider(req.params.provider), mangaId = text(req.params.mangaId, 100, true);
    const chapterId = text(req.body?.chapterId, 100, true), language = text(req.body?.idioma, 16, true);
    const revision = req.body?.revisaoEsperada, page = req.body?.pagina;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(page) || page < 1) throw new HttpError(400, 'INVALID_PROGRESS', 'Página ou revisão inválida.');
    const { client, context } = await authorizeChapter(db, req.user!.id, provider, chapterId);
    if (context.chapter.mangaId !== mangaId || context.chapter.language !== language) throw new HttpError(400, 'CHAPTER_MISMATCH', 'Capítulo, obra e idioma não correspondem.');
    const manifest = await client.getChapterManifest(chapterId);
    if (page > manifest.totalPages) throw new HttpError(400, 'INVALID_PAGE', 'Página inexistente.');
    let conflict = false;
    if (revision === 0) {
      try { await db.query('INSERT INTO progresso_leitura (usuario_id, provider, manga_id, chapter_id, idioma, pagina, total_paginas, revisao) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', [req.user!.id, provider, mangaId, chapterId, language, page, manifest.totalPages]); }
      catch (error: any) { if (error.code === 'ER_DUP_ENTRY') conflict = true; else throw error; }
    } else {
      const [result] = await db.query<ResultSetHeader>('UPDATE progresso_leitura SET chapter_id=?, pagina=?, total_paginas=?, revisao=revisao+1, atualizado_em=UTC_TIMESTAMP() WHERE usuario_id=? AND provider=? AND manga_id=? AND idioma=? AND revisao=?', [chapterId, page, manifest.totalPages, req.user!.id, provider, mangaId, language, revision]);
      conflict = !result.affectedRows;
    }
    const [rows] = await db.query<RowDataPacket[]>('SELECT chapter_id, pagina, total_paginas, revisao, idioma FROM progresso_leitura WHERE usuario_id=? AND provider=? AND manga_id=? AND idioma=?', [req.user!.id, provider, mangaId, language]);
    if (conflict) { res.status(409).json({ code: 'STALE_REVISION', message: 'O progresso mudou em outra aba. Recarregue para continuar.', currentProgress: rows[0] ?? null }); return; }
    emit({ usuario_id: req.user!.id, acao: 'progresso.atualizado', recurso: `manga:${provider}:${mangaId}`, resultado: 'sucesso' });
    res.json(rows[0]);
  });
  router.get('/curadoria/integracao', makeAuthenticate(db), requireRole('curador', 'admin'), async (_req, res) => {
    const [queue] = await db.query<RowDataPacket[]>('SELECT status, COUNT(*) AS total FROM minio_objetos_pendentes_remocao GROUP BY status');
    res.json({ providers: await Promise.all(['demo', 'mangadex'].map(p => getCatalogProvider(p).getDiagnostics())), cleanup: queue });
  });
  return router;
}
