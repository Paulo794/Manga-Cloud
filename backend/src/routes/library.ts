import { Router } from 'express';
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import multer from 'multer';
import { pipeline } from 'stream';
import { AuthRequest, makeAuthenticate } from '../middleware/authMiddleware';
import { id, text, pagination, missing, HttpError } from '../http';
import { assertValidProvider, getCatalogProvider } from '../providers';
import { ownShelf, hydrateReferences } from '../services/library';
import { ObjectStore, COVERS_BUCKET, validateImage, limitUploads, queueRemoval, compensateObject } from '../services/storage';
import { audit } from '../audit/auditClient';

export function libraryRouter(db: Pool, store: ObjectStore, emit: typeof audit = audit) {
  const router = Router();
  router.use(makeAuthenticate(db));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
  function event(req: AuthRequest, action: string, resource: string) {
    emit({ usuario_id: req.user!.id, acao: action, resultado: 'sucesso', recurso: resource, detalhe: { role: req.user!.role } });
  }
  const ensureOwner = async (req: AuthRequest, _res: any, next: any) => {
    try { await ownShelf(db, req.user!.id, id(req.params.id)); next(); } catch (error) { next(error); }
  };
  router.get('/', async (req: AuthRequest, res) => {
    const { page, limit, offset } = pagination(req.query);
    const [rows] = await db.query<RowDataPacket[]>(`SELECT e.id, e.nome, e.descricao, e.criado_em, e.atualizado_em,
      (SELECT COUNT(*) FROM estante_itens i WHERE i.estante_id=e.id) AS totalItens,
      EXISTS(SELECT 1 FROM estante_capas c WHERE c.estante_id=e.id) AS possuiCapa
      FROM estantes e WHERE e.usuario_id=? ORDER BY e.atualizado_em DESC, e.id DESC LIMIT ? OFFSET ?`, [req.user!.id, limit, offset]);
    const [count] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM estantes WHERE usuario_id=?', [req.user!.id]);
    res.json({ items: rows, page, limit, total: Number(count[0]!.total) });
  });
  router.post('/', async (req: AuthRequest, res) => {
    const name = text(req.body?.nome, 100, true), description = req.body?.descricao == null ? null : text(req.body.descricao, 1000);
    const [result] = await db.query<ResultSetHeader>('INSERT INTO estantes (usuario_id, nome, descricao) VALUES (?, ?, ?)', [req.user!.id, name, description]);
    event(req, 'estante.criada', `estante:${result.insertId}`);
    res.status(201).json({ id: result.insertId, nome: name, descricao: description });
  });
  router.get('/:id', async (req: AuthRequest, res) => {
    const shelf = await ownShelf(db, req.user!.id, id(req.params.id));
    const { page, limit, offset } = pagination(req.query);
    const [items] = await db.query<RowDataPacket[]>('SELECT i.* FROM estante_itens i JOIN estantes e ON e.id=i.estante_id WHERE i.estante_id=? AND e.usuario_id=? ORDER BY i.ordem, i.id LIMIT ? OFFSET ?', [shelf.id, req.user!.id, limit, offset]);
    const [count] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM estante_itens i JOIN estantes e ON e.id=i.estante_id WHERE i.estante_id=? AND e.usuario_id=?', [shelf.id, req.user!.id]);
    const [cover] = await db.query<RowDataPacket[]>('SELECT c.mime_type, c.largura_px, c.altura_px FROM estante_capas c JOIN estantes e ON e.id=c.estante_id WHERE e.id=? AND e.usuario_id=?', [shelf.id, req.user!.id]);
    res.json({ ...shelf, capa: cover[0] ?? null, items: await hydrateReferences(items), page, limit, total: Number(count[0]!.total) });
  });
  router.patch('/:id', async (req: AuthRequest, res) => {
    const shelf = await ownShelf(db, req.user!.id, id(req.params.id));
    const name = req.body?.nome === undefined ? shelf.nome : text(req.body.nome, 100, true);
    const description = req.body?.descricao === undefined ? shelf.descricao : req.body.descricao === null ? null : text(req.body.descricao, 1000);
    if (req.body?.nome === undefined && req.body?.descricao === undefined) throw new HttpError(400, 'INVALID_INPUT', 'Informe nome ou descrição.');
    const [result] = await db.query<ResultSetHeader>('UPDATE estantes SET nome=?, descricao=?, atualizado_em=UTC_TIMESTAMP() WHERE id=? AND usuario_id=?', [name, description, shelf.id, req.user!.id]);
    if (!result.affectedRows) throw missing();
    event(req, 'estante.editada', `estante:${shelf.id}`);
    res.json({ id: shelf.id, nome: name, descricao: description });
  });
  router.delete('/:id', async (req: AuthRequest, res) => {
    const shelfId = id(req.params.id), conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await ownShelf(conn, req.user!.id, shelfId, true);
      await conn.query("INSERT IGNORE INTO minio_objetos_pendentes_remocao (bucket, object_key, motivo) SELECT ?, c.object_key, 'estante_excluida' FROM estante_capas c JOIN estantes e ON e.id=c.estante_id WHERE e.id=? AND e.usuario_id=?", [COVERS_BUCKET, shelfId, req.user!.id]);
      await conn.query('DELETE FROM estantes WHERE id=? AND usuario_id=?', [shelfId, req.user!.id]);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    event(req, 'estante.excluida', `estante:${shelfId}`);
    res.sendStatus(204);
  });
  router.post('/:id/itens', ensureOwner, async (req: AuthRequest, res) => {
    const provider = assertValidProvider(req.body?.provider), mangaId = text(req.body?.mangaId, 100, true);
    await getCatalogProvider(provider).getMangaById(mangaId);
    // INSERT...SELECT mantém o escopo mesmo se o pai mudar/desaparecer durante o fetch externo.
    const [result] = await db.query<ResultSetHeader>('INSERT INTO estante_itens (estante_id, provider, manga_id, ordem) SELECT e.id, ?, ?, 0 FROM estantes e WHERE e.id=? AND e.usuario_id=?', [provider, mangaId, id(req.params.id), req.user!.id]);
    if (!result.affectedRows) throw missing();
    event(req, 'estante.item_adicionado', `estante:${req.params.id}`);
    res.status(201).json({ id: result.insertId, provider, manga_id: mangaId });
  });
  router.patch('/:id/itens/:itemId', ensureOwner, async (req: AuthRequest, res) => {
    const order = req.body?.ordem;
    if (!Number.isSafeInteger(order) || order < 0 || order > 1000000) throw new HttpError(400, 'INVALID_ORDER', 'Ordem inválida.');
    const [result] = await db.query<ResultSetHeader>('UPDATE estante_itens i JOIN estantes e ON e.id=i.estante_id SET i.ordem=? WHERE i.id=? AND e.id=? AND e.usuario_id=?', [order, id(req.params.itemId), id(req.params.id), req.user!.id]);
    if (!result.affectedRows) throw missing();
    event(req, 'estante.item_ordenado', `estante:${req.params.id}`);
    res.json({ message: 'Ordem atualizada.' });
  });
  router.delete('/:id/itens/:itemId', ensureOwner, async (req: AuthRequest, res) => {
    const [result] = await db.query<ResultSetHeader>('DELETE i FROM estante_itens i JOIN estantes e ON e.id=i.estante_id WHERE i.id=? AND e.id=? AND e.usuario_id=?', [id(req.params.itemId), id(req.params.id), req.user!.id]);
    if (!result.affectedRows) throw missing();
    event(req, 'estante.item_removido', `estante:${req.params.id}`);
    res.sendStatus(204);
  });
  router.post('/:id/capa', ensureOwner, limitUploads, upload.single('capa'), async (req: AuthRequest, res) => {
    const image = await validateImage(req.file), key = `capas/${image.key}`, shelfId = id(req.params.id);
    await store.put(COVERS_BUCKET, key, image.data, image.mime);
    const conn = await db.getConnection().catch(async error => { await compensateObject(db, store, COVERS_BUCKET, key); throw error; });
    try {
      await conn.beginTransaction();
      await ownShelf(conn, req.user!.id, shelfId, true);
      const [old] = await conn.query<RowDataPacket[]>('SELECT object_key FROM estante_capas WHERE estante_id=?', [shelfId]);
      if (old[0]) await queueRemoval(conn, COVERS_BUCKET, old[0].object_key, 'capa_substituida');
      await conn.query(`INSERT INTO estante_capas (estante_id, object_key, mime_type, tamanho_bytes, largura_px, altura_px, nome_original) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE object_key=VALUES(object_key), mime_type=VALUES(mime_type), tamanho_bytes=VALUES(tamanho_bytes), largura_px=VALUES(largura_px), altura_px=VALUES(altura_px), nome_original=VALUES(nome_original)`,
      [shelfId, key, image.mime, image.data.length, image.width, image.height, image.original]);
      await conn.commit();
    } catch (error) { await conn.rollback(); await compensateObject(db, store, COVERS_BUCKET, key); throw error; }
    finally { conn.release(); }
    event(req, 'estante.capa_enviada', `estante:${shelfId}`);
    res.status(201).json({ url: `/api/estantes/${shelfId}/capa`, width: image.width, height: image.height });
  });
  router.get('/:id/capa', ensureOwner, async (req: AuthRequest, res, next) => {
    const [rows] = await db.query<RowDataPacket[]>('SELECT c.* FROM estante_capas c JOIN estantes e ON e.id=c.estante_id WHERE e.id=? AND e.usuario_id=?', [id(req.params.id), req.user!.id]);
    if (!rows[0]) throw missing();
    const stream = await store.get(COVERS_BUCKET, rows[0].object_key);
    res.set({ 'Content-Type': rows[0].mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    pipeline(stream, res, error => { if (error) next(error); });
  });
  router.delete('/:id/capa', ensureOwner, async (req: AuthRequest, res) => {
    const conn = await db.getConnection(), shelfId = id(req.params.id);
    try {
      await conn.beginTransaction();
      await ownShelf(conn, req.user!.id, shelfId, true);
      const [rows] = await conn.query<RowDataPacket[]>('SELECT object_key FROM estante_capas WHERE estante_id=?', [shelfId]);
      if (!rows[0]) throw missing();
      await queueRemoval(conn, COVERS_BUCKET, rows[0].object_key, 'capa_removida');
      await conn.query('DELETE FROM estante_capas WHERE estante_id=?', [shelfId]);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    event(req, 'estante.capa_removida', `estante:${shelfId}`);
    res.sendStatus(204);
  });
  return router;
}
