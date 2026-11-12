import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../db/connection';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { sendResetEmail } from '../utils/mail';
import { AuthRequest } from '../middlewares/authMiddleware';
import { audit } from '../audit/auditClient';
import { AUTH_LOGIN, AUTH_FALHA, AUTH_REGISTRO, AUTH_SENHA_REDEFINIDA } from '../audit/actions';

function jwtSecret(): string {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não configurado');
  return process.env.JWT_SECRET;
}

export type UserRole = 'leitor' | 'curador' | 'admin';

export function normalizeUserRole(rawRole: unknown): UserRole {
  if (rawRole === 'admin' || rawRole === 'curador' || rawRole === 'leitor') {
    return rawRole;
  }
  return 'leitor';
}

export interface AuthDbAdapter {
  query<T extends RowDataPacket[] | ResultSetHeader>(sql: string, params?: unknown[]): Promise<[T, unknown]>;
}

export function createAuthHandlers(db: AuthDbAdapter = pool as unknown as AuthDbAdapter, emit: typeof audit = audit) {
  const register = async (req: Request, res: Response): Promise<void> => {
    try {
      const rawNome = typeof req.body?.nome === 'string' ? req.body.nome.trim() : '';
      const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const rawSenha = typeof req.body?.senha === 'string' ? req.body.senha : '';

      if (!rawNome || rawNome.length > 100) {
        res.status(400).json({ code: 'INVALID_NAME', error: 'Nome é obrigatório e deve ter até 100 caracteres.' });
        return;
      }

      if (!rawEmail || rawEmail.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        res.status(400).json({ code: 'INVALID_EMAIL', error: 'Email inválido.' });
        return;
      }

      if (!rawSenha || rawSenha.length < 6 || Buffer.byteLength(rawSenha) > 72) {
        res.status(400).json({ code: 'INVALID_PASSWORD', error: 'A senha deve ter pelo menos 6 caracteres.' });
        return;
      }

      const [existing] = await db.query<RowDataPacket[]>('SELECT id FROM usuarios WHERE email = ?', [rawEmail]);
      if (existing.length > 0) {
        res.status(400).json({ code: 'EMAIL_ALREADY_EXISTS', error: 'Email já cadastrado' });
        return;
      }

      // QA-02: Cadastro público SEMPRE grava role = 'leitor', ignorando qualquer tentativa de mass assignment
      // (role, is_premium, stripe_customer_id, bio, id) enviada no payload.
      const fixedRole: UserRole = 'leitor';
      const hashedPassword = await bcrypt.hash(rawSenha, 10);
      const [result] = await db.query<ResultSetHeader>(
        'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)',
        [rawNome, rawEmail, hashedPassword, fixedRole]
      );

      emit({
        usuario_id: result.insertId,
        acao: AUTH_REGISTRO,
        resultado: 'sucesso',
        ip: req.ip || req.socket?.remoteAddress,
        recurso: `usuario:${result.insertId}`,
        detalhe: { role: fixedRole }
      });

      res.status(201).json({
        message: 'Usuário cadastrado com sucesso',
        user: {
          id: result.insertId,
          nome: rawNome,
          email: rawEmail,
          role: fixedRole
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Email já cadastrado.' }); return; }
      console.error('Falha no cadastro.');
      res.status(500).json({ error: 'Erro interno no servidor' });
    }
  };

  const login = async (req: Request, res: Response): Promise<void> => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const senha = typeof req.body?.senha === 'string' ? req.body.senha : '';

      if (!email || !senha) {
        res.status(400).json({ code: 'CREDENTIALS_REQUIRED', error: 'Email e senha são obrigatórios' });
        return;
      }

      const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM usuarios WHERE email = ?', [email]);
      const user = rows[0];

      if (!user) {
        emit({
          usuario_id: null,
          acao: AUTH_FALHA,
          resultado: 'negado',
          ip: req.ip || req.socket?.remoteAddress,
          recurso: 'POST /auth/login'
        });
        res.status(401).json({ error: 'Credenciais inválidas' });
        return;
      }

      const match = await bcrypt.compare(senha, user.senha_hash);
      if (!match) {
        emit({
          usuario_id: user.id,
          acao: AUTH_FALHA,
          resultado: 'negado',
          ip: req.ip || req.socket?.remoteAddress,
          recurso: `usuario:${user.id}`
        });
        res.status(401).json({ error: 'Credenciais inválidas' });
        return;
      }

      const normalizedRole = normalizeUserRole(user.role);
      const token = jwt.sign(
        { id: user.id, email: user.email, role: normalizedRole },
        jwtSecret(),
        { expiresIn: '24h' }
      );

      emit({
        usuario_id: user.id,
        acao: AUTH_LOGIN,
        resultado: 'sucesso',
        ip: req.ip || req.socket?.remoteAddress,
        detalhe: { role: normalizedRole }
      });

      res.json({
        token,
        user: {
          id: user.id,
          nome: user.nome,
          email: user.email,
          role: normalizedRole
        }
      });
    } catch (error) {
      console.error('Falha no serviço de autenticação.');
      res.status(500).json({ error: 'Erro no login' });
    }
  };

  const verify = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const payload = typeof req.user === 'object' && req.user !== null ? req.user : null;
      const userId = payload && 'id' in payload ? Number(payload.id) : NaN;
      if (!Number.isInteger(userId) || userId <= 0) {
        res.status(401).json({ valid: false, error: 'Token inválido' });
        return;
      }

      // REV-04: Revalida o papel atual diretamente no banco para refletir rebaixamento imediato
      const [rows] = await db.query<RowDataPacket[]>(
        'SELECT id, nome, email, role FROM usuarios WHERE id = ? LIMIT 1',
        [userId]
      );
      if (rows.length === 0) {
        res.status(401).json({ valid: false, error: 'Usuário não encontrado' });
        return;
      }

      const currentUser = rows[0];
      const currentRole = normalizeUserRole(currentUser.role);
      res.json({
        valid: true,
        user: {
          id: currentUser.id,
          nome: currentUser.nome,
          email: currentUser.email,
          role: currentRole
        }
      });
    } catch (error) {
      console.error('Falha no serviço de autenticação.');
      res.status(503).json({ valid: false, error: 'Serviço de verificação indisponível' });
    }
  };

  const forgotPassword = async (req: Request, res: Response): Promise<void> => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (!email || email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ code: 'INVALID_EMAIL', error: 'Email inválido.' }); return;
      }
      const configuredBaseUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
      let origin: URL;
      try {
        origin = new URL(configuredBaseUrl);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Invalid origin');
      } catch { res.status(503).json({ error: 'Recuperação de senha não configurada.' }); return; }
      const [rows] = await db.query<RowDataPacket[]>('SELECT id FROM usuarios WHERE email = ?', [email]);
      const user = rows[0];

      if (!user) {
        res.json({ message: 'Se o email existir, um link foi enviado.' });
        return;
      }

      const token = crypto.randomBytes(32).toString('hex');

      await db.query(
        'INSERT INTO reset_tokens (token, usuario_id, expira_em) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))',
        [token, user.id]
      );

      const resetLink = `${origin.origin}/reset-password?token=${token}`;
      await sendResetEmail(email, resetLink);

      res.json({ message: 'Se o email existir, um link foi enviado.' });
    } catch (error) {
      console.error('Falha no serviço de autenticação.');
      res.status(500).json({ error: 'Erro ao processar esqueci a senha' });
    }
  };

  const resetPassword = async (req: Request, res: Response): Promise<void> => {
    try {
      const token = req.body?.token, novaSenha = req.body?.novaSenha;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) { res.status(400).json({ error: 'Token inválido ou expirado' }); return; }
      if (typeof novaSenha !== 'string' || novaSenha.length < 6 || Buffer.byteLength(novaSenha) > 72) {
        res.status(400).json({ code: 'INVALID_PASSWORD', error: 'A nova senha deve ter pelo menos 6 caracteres.' });
        return;
      }

      const [rows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM reset_tokens WHERE token = ? AND usado = FALSE AND expira_em > UTC_TIMESTAMP()',
        [token]
      );
      const resetRecord = rows[0];

      if (!resetRecord) {
        res.status(400).json({ error: 'Token inválido ou expirado' });
        return;
      }

      const hashedPassword = await bcrypt.hash(novaSenha, 10);

      const [updated] = await db.query<ResultSetHeader>(
        'UPDATE usuarios u JOIN reset_tokens r ON r.usuario_id=u.id SET u.senha_hash=?, r.usado=TRUE WHERE r.token=? AND r.usado=FALSE AND r.expira_em > UTC_TIMESTAMP()',
        [hashedPassword, token]
      );
      if (!updated.affectedRows) { res.status(400).json({ error: 'Token inválido ou expirado' }); return; }

      emit({
        usuario_id: resetRecord.usuario_id,
        acao: AUTH_SENHA_REDEFINIDA,
        resultado: 'sucesso',
        ip: req.ip || req.socket?.remoteAddress,
        recurso: `usuario:${resetRecord.usuario_id}`
      });

      res.json({ message: 'Senha atualizada com sucesso' });
    } catch (error) {
      console.error('Falha no serviço de autenticação.');
      res.status(500).json({ error: 'Erro ao redefinir a senha' });
    }
  };

  const currentAdmin = async (req: AuthRequest): Promise<number | null> => {
    const actor = typeof req.user === 'object' && req.user ? Number(req.user.id) : NaN;
    if (!Number.isSafeInteger(actor) || actor <= 0) return null;
    const [rows] = await db.query<RowDataPacket[]>('SELECT role FROM usuarios WHERE id=?', [actor]);
    return rows[0]?.role === 'admin' ? actor : null;
  };
  const listUsers = async (req: AuthRequest, res: Response) => {
    try {
      if (!await currentAdmin(req)) { res.status(403).json({ code: 'FORBIDDEN', error: 'Apenas administradores.' }); return; }
      const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 20);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        res.status(400).json({ error: 'Paginação inválida.' }); return;
      }
      const [rows] = await db.query<RowDataPacket[]>('SELECT id, nome, email, role, criado_em FROM usuarios ORDER BY id LIMIT ? OFFSET ?', [limit, (page - 1) * limit]);
      const [count] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM usuarios');
      res.json({ items: rows, page, limit, total: Number(count[0]!.total) });
    } catch { res.status(503).json({ error: 'Administração temporariamente indisponível.' }); }
  };
  const changeRole = async (req: AuthRequest, res: Response) => {
    try {
      const actor = await currentAdmin(req);
      if (!actor) { res.status(403).json({ code: 'FORBIDDEN', error: 'Apenas administradores.' }); return; }
      const target = Number(req.params.id), role = req.body?.papel;
      if (!Number.isSafeInteger(target) || target <= 0 || !['leitor', 'curador', 'admin'].includes(role)) {
        res.status(400).json({ error: 'Usuário ou papel inválido.' }); return;
      }
      if (target === actor) { res.status(409).json({ error: 'Não altere seu próprio papel nesta tela.' }); return; }
      const [result] = await db.query<ResultSetHeader>('UPDATE usuarios SET role=? WHERE id=?', [role, target]);
      if (!result.affectedRows) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      emit({ usuario_id: actor, acao: 'usuario.papel_alterado', resultado: 'sucesso', recurso: `usuario:${target}`, detalhe: { role } });
      res.json({ id: target, role });
    } catch { res.status(503).json({ error: 'Administração temporariamente indisponível.' }); }
  };
  return { register, login, verify, forgotPassword, resetPassword, listUsers, changeRole };
}

const defaultHandlers = createAuthHandlers();
export const register = defaultHandlers.register;
export const login = defaultHandlers.login;
export const verify = defaultHandlers.verify;
export const forgotPassword = defaultHandlers.forgotPassword;
export const resetPassword = defaultHandlers.resetPassword;
