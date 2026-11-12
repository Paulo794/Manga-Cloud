import crypto from 'crypto';
import sharp from 'sharp';
import { S3Client, HeadBucketCommand, CreateBucketCommand, DeleteBucketPolicyCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { HttpError } from '../http';
import type { Request, Response, NextFunction } from 'express';
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 20 });
let activeUploads = 0;
export function limitUploads(_req: Request, res: Response, next: NextFunction) {
  if (activeUploads >= 2) { res.setHeader('Retry-After', '1'); next(new HttpError(429, 'UPLOAD_BUSY', 'Há uploads em processamento. Tente novamente.')); return; }
  activeUploads++;
  let released = false;
  const release = () => { if (!released) { activeUploads--; released = true; } };
  res.once('finish', release); res.once('close', release); next();
}

export const COVERS_BUCKET = 'mangacloud-capas';
export const AVATARS_BUCKET = 'mangacloud-avatars';
export interface ObjectStore {
  ensure(): Promise<void>;
  put(bucket: string, key: string, data: Buffer, mime: string): Promise<void>;
  get(bucket: string, key: string): Promise<Readable>;
  remove(bucket: string, key: string): Promise<void>;
}
export class MinioStore implements ObjectStore {
  private instance?: S3Client;
  private client() {
    if (!process.env.MINIO_ROOT_USER || !process.env.MINIO_ROOT_PASSWORD) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Armazenamento não configurado.');
    return this.instance ??= new S3Client({
      endpoint: `${process.env.MINIO_SSL === 'true' ? 'https' : 'http'}://${process.env.MINIO_ENDPOINT || 'minio'}:${Number(process.env.MINIO_PORT || 9000)}`,
      region: process.env.MINIO_REGION || 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.MINIO_ROOT_USER, secretAccessKey: process.env.MINIO_ROOT_PASSWORD },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, socketTimeout: 10000 }
    });
  }
  async ensure() {
    for (const bucket of [COVERS_BUCKET, AVATARS_BUCKET]) {
      try { await this.client().send(new HeadBucketCommand({ Bucket: bucket })); }
      catch (error: any) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
        try { await this.client().send(new CreateBucketCommand({ Bucket: bucket })); }
        catch (creationError: any) { if (creationError.name !== 'BucketAlreadyOwnedByYou') throw creationError; }
      }
      // Também corrige bucket previamente existente: nenhum acesso anônimo.
      await this.client().send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    }
  }
  async put(bucket: string, key: string, data: Buffer, mime: string) {
    try { await this.client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentLength: data.length, ContentType: mime })); }
    catch { throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Não foi possível armazenar a imagem.'); }
  }
  async get(bucket: string, key: string) {
    try {
      const result = await this.client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(result.Body instanceof Readable)) throw new Error('Invalid object stream');
      return result.Body;
    }
    catch { throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Imagem temporariamente indisponível.'); }
  }
  async remove(bucket: string, key: string) { await this.client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
}
export async function validateImage(file?: Express.Multer.File) {
  if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'Escolha uma imagem.');
  if (file.size > 5 * 1024 * 1024) throw new HttpError(413, 'FILE_TOO_LARGE', 'A imagem deve ter até 5 MiB.');
  try {
    const options = { limitInputPixels: 16000000, failOn: 'warning' as const, animated: false };
    const metadata = await sharp(file.buffer, options).metadata();
    const formats: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    if (!metadata.format || !formats[metadata.format] || formats[metadata.format] !== file.mimetype ||
        !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 ||
        metadata.width * metadata.height > 16000000 || (metadata.pages ?? 1) > 1) throw new Error('Invalid image');
    // Decodifica integralmente e reencoda: não confia só no MIME ou cabeçalho.
    const { data, info } = await sharp(file.buffer, options).rotate().webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, mime: 'image/webp', key: `${crypto.randomUUID()}.webp`, original: file.originalname.slice(0, 255) };
  } catch { throw new HttpError(415, 'INVALID_IMAGE', 'Envie uma imagem JPEG, PNG ou WebP válida, de até 4096 px e 16 MP.'); }
}
export async function queueRemoval(db: { query: Function }, bucket: string, key: string, reason: string) {
  await db.query('INSERT IGNORE INTO minio_objetos_pendentes_remocao (bucket, object_key, motivo) VALUES (?, ?, ?)', [bucket, key, reason]);
}
export async function compensateObject(db: Pool, store: ObjectStore, bucket: string, key: string) {
  try { await store.remove(bucket, key); }
  catch {
    try { await queueRemoval(db, bucket, key, 'rollback_upload'); }
    catch { console.error('[Storage] Limpeza compensatória pendente: banco e storage indisponíveis. Reconciliar objetos de upload.'); }
  }
}
export async function processPendingMinioDeletions(db: Pool, store: ObjectStore) {
  const conn = await db.getConnection();
  let rows: RowDataPacket[] = [];
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE minio_objetos_pendentes_remocao SET status='pending' WHERE status='processing' AND atualizado_em < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE)");
    const [claimed] = await conn.query<RowDataPacket[]>("SELECT * FROM minio_objetos_pendentes_remocao WHERE status='pending' AND proxima_tentativa_em <= UTC_TIMESTAMP() LIMIT 10 FOR UPDATE");
    rows = claimed;
    for (const row of rows) await conn.query("UPDATE minio_objetos_pendentes_remocao SET status='processing', tentativas=tentativas+1 WHERE id=?", [row.id]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
  for (const row of rows) {
    try {
      if (![COVERS_BUCKET, AVATARS_BUCKET].includes(row.bucket)) throw new Error('Invalid bucket');
      await store.remove(row.bucket, row.object_key);
      await db.query('DELETE FROM minio_objetos_pendentes_remocao WHERE id=?', [row.id]);
    } catch {
      const tries = Number(row.tentativas) + 1;
      await db.query("UPDATE minio_objetos_pendentes_remocao SET status=?, ultimo_erro='Falha de remoção; verificar storage', proxima_tentativa_em=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE id=?",
        [tries >= Number(row.max_tentativas) ? 'failed' : 'pending', Math.min(3600, 30 * 2 ** tries), row.id]);
    }
  }
  return rows.length;
}
