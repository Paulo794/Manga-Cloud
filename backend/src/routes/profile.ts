import { Router } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import multer from 'multer';
import { pipeline } from 'stream';
import { AuthRequest, makeAuthenticate } from '../middleware/authMiddleware';
import { HttpError, text, missing } from '../http';
import { currentSubscription } from '../services/library';
import { ObjectStore, AVATARS_BUCKET, validateImage, limitUploads, queueRemoval, compensateObject } from '../services/storage';

export function profileRouter(db: Pool, store: ObjectStore) {
  const router = Router();
  router.use(makeAuthenticate(db));
  router.get('/', async (req: AuthRequest, res) => {
    const [rows] = await db.query<RowDataPacket[]>('SELECT id, nome, email, bio, role, avatar_url FROM usuarios WHERE id=?', [req.user!.id]);
    if (!rows[0]) throw missing();
    res.json({ ...rows[0], avatar_url: rows[0].avatar_url?.startsWith('avatars/') ? '/api/profile/avatar' : null, assinatura: await currentSubscription(db, req.user!.id) });
  });
  router.put('/', async (req: AuthRequest, res) => {
    if (req.body?.id !== undefined && Number(req.body.id) !== req.user!.id) throw new HttpError(403, 'FORBIDDEN', 'Você só pode editar seu perfil.');
    const bio = text(req.body?.bio, 1000);
    await db.query('UPDATE usuarios SET bio=? WHERE id=?', [bio, req.user!.id]);
    res.json({ message: 'Perfil atualizado.' });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
  router.post('/avatar', limitUploads, upload.single('file'), async (req: AuthRequest, res) => {
    const image = await validateImage(req.file), key = `avatars/${image.key}`;
    await store.put(AVATARS_BUCKET, key, image.data, image.mime);
    const conn = await db.getConnection().catch(async error => { await compensateObject(db, store, AVATARS_BUCKET, key); throw error; });
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<RowDataPacket[]>('SELECT avatar_url FROM usuarios WHERE id=? FOR UPDATE', [req.user!.id]);
      if (!rows[0]) throw missing();
      if (rows[0].avatar_url?.startsWith('avatars/')) await queueRemoval(conn, AVATARS_BUCKET, rows[0].avatar_url, 'avatar_substituido');
      await conn.query('UPDATE usuarios SET avatar_url=? WHERE id=?', [key, req.user!.id]);
      await conn.commit();
    } catch (error) { await conn.rollback(); await compensateObject(db, store, AVATARS_BUCKET, key); throw error; }
    finally { conn.release(); }
    res.status(201).json({ avatar_url: '/api/profile/avatar' });
  });
  router.get('/avatar', async (req: AuthRequest, res, next) => {
    const [rows] = await db.query<RowDataPacket[]>('SELECT avatar_url FROM usuarios WHERE id=?', [req.user!.id]);
    if (!rows[0]?.avatar_url?.startsWith('avatars/')) throw missing();
    const stream = await store.get(AVATARS_BUCKET, rows[0].avatar_url);
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    pipeline(stream, res, error => { if (error) next(error); });
  });
  return router;
}
