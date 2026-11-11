import crypto from 'crypto';
import fs from 'fs';
import bcrypt from 'bcrypt';
import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import {
  acquireCoordinationLocks,
  releaseCoordinationLocks,
  resolveDbFilePath
} from './migrate';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const DEMO_OWNER_EMAIL = 'demo.biblioteca@mangacloud.local';

export interface ShelfSeedSpec {
  seedKey: string;
  nome: string;
  descricao: string;
  itens: Array<{
    provider: 'demo' | 'mangadex';
    mangaId: string;
    ordem: number;
  }>;
}

export const MANGACLOUD_DEMO_SHELVES: ShelfSeedSpec[] = [
  {
    seedKey: 'seed_estante_shounen',
    nome: 'Shounen e Ação — Demonstração',
    descricao:
      'Estante demonstrativa criada pelo seed com obras de múltiplos capítulos e numeração decimal para validação do Web Reader e do Paywall.',
    itens: [
      { provider: 'demo', mangaId: 'demo-alquimia-astral', ordem: 1 },
      { provider: 'demo', mangaId: 'demo-cyber-ronin', ordem: 2 }
    ]
  },
  {
    seedKey: 'seed_estante_idiomas',
    nome: 'Obras Internacionais (EN)',
    descricao:
      'Estante demonstrativa contendo obra publicada exclusivamente em inglês para validação de troca de idioma.',
    itens: [{ provider: 'demo', mangaId: 'demo-lenda-sem-ptbr', ordem: 1 }]
  }
];

interface QaAccountEnvSpec {
  role: 'leitor' | 'curador' | 'admin';
  emailEnv: string;
  passwordEnv: string;
  defaultName: string;
}

const QA_ACCOUNT_SPECS: QaAccountEnvSpec[] = [
  {
    role: 'leitor',
    emailEnv: 'QA_LEITOR_EMAIL',
    passwordEnv: 'QA_LEITOR_PASSWORD',
    defaultName: 'Leitor QA MangaCloud'
  },
  {
    role: 'curador',
    emailEnv: 'QA_CURADOR_EMAIL',
    passwordEnv: 'QA_CURADOR_PASSWORD',
    defaultName: 'Curador QA MangaCloud'
  },
  {
    role: 'admin',
    emailEnv: 'QA_ADMIN_EMAIL',
    passwordEnv: 'QA_ADMIN_PASSWORD',
    defaultName: 'Admin QA MangaCloud'
  }
];

const EPHEMERAL_SEED_SECRET = crypto.randomBytes(32).toString('hex');

function getQaProvenanceSecret(): string {
  return (
    process.env.INTERNAL_SERVICE_TOKEN ||
    process.env.JWT_SECRET ||
    EPHEMERAL_SEED_SECRET
  );
}

export function buildQaProvenanceMarker(email: string, role: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedRole = role.trim().toLowerCase();
  const mac = crypto
    .createHmac('sha256', getQaProvenanceSecret())
    .update(`mangacloud-qa-v1:${normalizedEmail}:${normalizedRole}`)
    .digest('hex');
  return `[QA-PROVISIONED:${mac}] Conta provisionada para testes (${normalizedRole})`;
}

export function hasValidQaProvenance(
  bio: unknown,
  email: string,
  expectedRole: string
): boolean {
  if (typeof bio !== 'string' || !bio.startsWith('[QA-PROVISIONED:')) {
    return false;
  }
  const expectedMarker = buildQaProvenanceMarker(email, expectedRole);
  const expectedPrefix = expectedMarker.slice(0, expectedMarker.indexOf(']') + 1);
  const actualPrefix = bio.slice(0, bio.indexOf(']') + 1);
  if (expectedPrefix.length !== actualPrefix.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(actualPrefix, 'utf-8'),
    Buffer.from(expectedPrefix, 'utf-8')
  );
}

function validateQaEnvConfiguration(): Array<{
  spec: QaAccountEnvSpec;
  email: string;
  password: string;
}> {
  const activeConfigs: Array<{ spec: QaAccountEnvSpec; email: string; password: string }> = [];
  const seenEmails = new Set<string>();

  for (const spec of QA_ACCOUNT_SPECS) {
    const email = (process.env[spec.emailEnv] ?? '').trim().toLowerCase();
    const password = process.env[spec.passwordEnv] ?? '';

    if ((email && !password) || (!email && password)) {
      throw new Error(
        `Configuração QA incompleta para o papel '${spec.role}': defina ambos ${spec.emailEnv} e ${spec.passwordEnv}.`
      );
    }

    if (!email && !password) {
      continue;
    }

    if (email === DEMO_OWNER_EMAIL) {
      throw new Error(
        `Email '${email}' é reservado para a conta demonstrativa de estantes e não pode ser usado em ${spec.emailEnv}.`
      );
    }

    if (seenEmails.has(email)) {
      throw new Error(
        `Conflito na configuração QA: o email '${email}' foi atribuído a mais de um papel de QA.`
      );
    }

    seenEmails.add(email);
    activeConfigs.push({ spec, email, password });
  }

  return activeConfigs;
}

/**
 * F2A-01: Provisionamento seguro de contas QA:
 * - Valida pares email/senha e unicidade entre os 3 papéis antes de qualquer gravação.
 * - NUNCA usa '[QA-ACCOUNT]' em texto puro na bio para sobrescrever senha ou promover papel.
 * - NUNCA promove papel nem altera senha de conta pré-existente no seed.
 * - Só reconhece uma conta existente como já provisionada se o papel já coincidir E possuir assinatura HMAC válida do servidor.
 */
async function provisionOptionalQaAccounts(conn: mysql.Connection): Promise<number> {
  const activeConfigs = validateQaEnvConfiguration();
  let provisionedCount = 0;

  for (const { spec, email, password } of activeConfigs) {
    const [existingRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, email, role, bio FROM usuarios WHERE email = ?',
      [email]
    );
    const existing = existingRows[0];

    if (existing) {
      const existingRole = String(existing.role ?? '').trim().toLowerCase();
      const isVerifiedQa =
        existingRole === spec.role &&
        hasValidQaProvenance(existing.bio, email, spec.role);

      if (!isVerifiedQa) {
        throw new Error(
          `Recusado provisionar conta QA (${spec.role}) para '${email}': este email já pertence a uma conta não-QA existente (id=${String(existing.id)}). O seed nunca altera senha ou papel de conta pré-existente.`
        );
      }

      // Conta QA já foi criada anteriormente com o mesmo papel verificado; preserva sem sobrescrever
      provisionedCount++;
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      const provenanceBio = buildQaProvenanceMarker(email, spec.role);
      await conn.query(
        'INSERT INTO usuarios (nome, email, senha_hash, role, bio, is_premium) VALUES (?, ?, ?, ?, ?, 0)',
        [spec.defaultName, email, passwordHash, spec.role, provenanceBio]
      );
      provisionedCount++;
    }
  }

  return provisionedCount;
}

export async function runSeed(): Promise<{
  insertedShelves: number;
  preservedExistingShelves: number;
  provisionedQaAccounts: number;
}> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  let acquiredLocks: string[] = [];

  try {
    acquiredLocks = await acquireCoordinationLocks(conn, 10);

    // 1. Executar SQL declarativo base (003_seed_mangacloud.sql)
    const sqlPath = resolveDbFilePath('003_seed_mangacloud.sql');
    const rawSql = fs.readFileSync(sqlPath, 'utf-8');
    const statements = rawSql
      .split(/;\s*$/m)
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim()
      )
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await conn.query(stmt);
    }

    const [ownerRows] = await conn.query<RowDataPacket[]>(
      'SELECT id FROM usuarios WHERE email = ?',
      [DEMO_OWNER_EMAIL]
    );
    const ownerRow = ownerRows[0];
    if (!ownerRow || ownerRow.id == null) {
      throw new Error(`Conta demonstrativa '${DEMO_OWNER_EMAIL}' não encontrada após seed SQL.`);
    }
    const demoUserId = Number(ownerRow.id);

    let insertedShelves = 0;
    let preservedExistingShelves = 0;

    // 2. Criar/verificar estantes demonstrativas usando seed_key estável (Invariante 3 de QA):
    // Se o usuário já editou o nome/descrição da estante, NÃO sobrescreve nem duplica!
    for (const shelf of MANGACLOUD_DEMO_SHELVES) {
      await conn.beginTransaction();
      try {
        const [existingShelves] = await conn.query<RowDataPacket[]>(
          'SELECT id, nome FROM estantes WHERE usuario_id = ? AND seed_key = ? FOR UPDATE',
          [demoUserId, shelf.seedKey]
        );
        const existingShelf = existingShelves[0];

        let estanteId: number;
        if (existingShelf && existingShelf.id != null) {
          estanteId = Number(existingShelf.id);
          preservedExistingShelves++;
        } else {
          const [insertRes] = await conn.query<ResultSetHeader>(
            'INSERT INTO estantes (usuario_id, seed_key, nome, descricao) VALUES (?, ?, ?, ?)',
            [demoUserId, shelf.seedKey, shelf.nome, shelf.descricao]
          );
          estanteId = insertRes.insertId;
          insertedShelves++;

          for (const item of shelf.itens) {
            await conn.query(
              'INSERT IGNORE INTO estante_itens (estante_id, provider, manga_id, ordem) VALUES (?, ?, ?, ?)',
              [estanteId, item.provider, item.mangaId, item.ordem]
            );
          }
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    }

    // 3. Favorito demonstrativo inicial (INSERT IGNORE)
    await conn.query(
      'INSERT IGNORE INTO favoritos_manga (usuario_id, provider, manga_id) VALUES (?, ?, ?)',
      [demoUserId, 'demo', 'demo-alquimia-astral']
    );

    // 4. Provisionamento explícito e seguro de contas QA via variáveis de ambiente
    const provisionedQaAccounts = await provisionOptionalQaAccounts(conn);

    console.log(
      `[Seed] Concluído: estantes criadas=${insertedShelves}, estantes existentes preservadas=${preservedExistingShelves}, contas QA=${provisionedQaAccounts}.`
    );

    return {
      insertedShelves,
      preservedExistingShelves,
      provisionedQaAccounts
    };
  } finally {
    if (acquiredLocks.length > 0) {
      await releaseCoordinationLocks(conn, acquiredLocks);
    }
    await conn.end();
  }
}

if (require.main === module) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Seed] ERRO:', err.message);
      process.exit(1);
    });
}
