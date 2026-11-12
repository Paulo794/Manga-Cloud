import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

/**
 * Chaves de coordenação adquiridas em ordem alfabética fixa (Invariante 2 da Seção 5 de QA):
 * Garante exclusão mútua contra o runner legado de migração, contra o seed legado e no MangaCloud.
 */
export const COORDINATION_LOCKS = [
  'acervo_tricolor_migration_lock',
  'acervo_tricolor_seed_lock',
  'mangacloud_migration_lock'
] as const;

export const ALLOWED_KNOWN_ROLES = [
  'usuario',
  'editor',
  'pesquisador',
  'curador',
  'cliente',
  'barbeiro',
  'leitor',
  'admin'
] as const;

const LEGACY_FOOTBALL_TABLES = [
  'temporadas',
  'jogadores',
  'temporada_jogadores',
  'campanhas',
  'fontes_temporada',
  'dossies',
  'dossie_temporadas',
  'anexos_dossie'
] as const;

export interface MigrationDefinition {
  version: string;
  filename: string;
  runLegacyUserUpgrade?: boolean;
  runMangaCloudRoleTransition?: boolean;
}

export const LEGACY_001_MIGRATION: MigrationDefinition = {
  version: '001_dominio_acervo_tricolor',
  filename: '001_dominio.sql',
  runLegacyUserUpgrade: true
};

export const MANGACLOUD_002_MIGRATION: MigrationDefinition = {
  version: '002_dominio_mangacloud',
  filename: '002_dominio_mangacloud.sql',
  runMangaCloudRoleTransition: true
};

export const BILLING_004_MIGRATION: MigrationDefinition = {
  version: '004_identidade_cobranca',
  filename: '004_identidade_cobranca.sql'
};

export const DEFAULT_MIGRATIONS: MigrationDefinition[] = [
  LEGACY_001_MIGRATION,
  MANGACLOUD_002_MIGRATION,
  BILLING_004_MIGRATION
];

export function resolveDbFilePath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, '../../../db', filename),
    path.resolve(__dirname, '../../db', filename),
    path.resolve(process.cwd(), '../db', filename),
    path.resolve(process.cwd(), 'db', filename)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Arquivo de banco '${filename}' não encontrado nos caminhos esperados.`);
}

export async function acquireCoordinationLocks(
  conn: mysql.Connection,
  timeoutSeconds = 10
): Promise<string[]> {
  const acquired: string[] = [];
  try {
    for (const lockName of COORDINATION_LOCKS) {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS locked', [
        lockName,
        timeoutSeconds
      ]);
      const first = rows[0];
      if (!first || Number(first.locked) !== 1) {
        throw new Error(
          `Não foi possível adquirir o lock '${lockName}' (outra execução concorrente de migration/seed está ativa).`
        );
      }
      acquired.push(lockName);
    }
    return acquired;
  } catch (err) {
    for (const lockName of [...acquired].reverse()) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        // Ignora erro no release de emergência
      }
    }
    throw err;
  }
}

export async function releaseCoordinationLocks(
  conn: mysql.Connection,
  acquired: string[]
): Promise<void> {
  for (const lockName of [...acquired].reverse()) {
    try {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch {
      // Ignora erro no release
    }
  }
}

async function ensureUsuariosColumns(
  conn: mysql.Connection,
  defaultRole: 'pesquisador' | 'leitor'
): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SHOW CREATE TABLE `usuarios`');
  const firstRow = rows[0];
  const createSql = String(firstRow ? firstRow['Create Table'] ?? '' : '');

  const columnsToEnsure: Array<{ name: string; ddl: string }> = [
    { name: 'criado_em', ddl: 'ADD COLUMN `criado_em` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP' },
    { name: 'role', ddl: `ADD COLUMN \`role\` VARCHAR(20) NOT NULL DEFAULT '${defaultRole}'` },
    { name: 'bio', ddl: 'ADD COLUMN `bio` TEXT DEFAULT NULL' },
    { name: 'avatar_url', ddl: 'ADD COLUMN `avatar_url` VARCHAR(500) DEFAULT NULL' },
    { name: 'is_premium', ddl: 'ADD COLUMN `is_premium` TINYINT(1) DEFAULT 0' },
    { name: 'stripe_customer_id', ddl: 'ADD COLUMN `stripe_customer_id` VARCHAR(255) DEFAULT NULL' }
  ];

  for (const col of columnsToEnsure) {
    if (!createSql.includes(`\`${col.name}\``)) {
      try {
        await conn.query(`ALTER TABLE \`usuarios\` ${col.ddl}`);
        console.log(`[Migrate] Coluna '${col.name}' adicionada em 'usuarios'.`);
      } catch (err: any) {
        if (err.code !== 'ER_DUP_FIELDNAME') {
          throw err;
        }
      }
    }
  }
}

async function ensureEstantesColumns(conn: mysql.Connection): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SHOW CREATE TABLE `estantes`');
  const firstRow = rows[0];
  const createSql = String(firstRow ? firstRow['Create Table'] ?? '' : '');

  if (!createSql.includes('`seed_key`')) {
    await conn.query('ALTER TABLE `estantes` ADD COLUMN `seed_key` VARCHAR(64) DEFAULT NULL AFTER `usuario_id`');
  }
  if (!createSql.includes('uk_estantes_usuario_seed_key')) {
    await conn.query('ALTER TABLE `estantes` ADD UNIQUE KEY `uk_estantes_usuario_seed_key` (`usuario_id`, `seed_key`)');
  }
}

async function migrateLegacyRolesToAcervo(conn: mysql.Connection): Promise<void> {
  await conn.query("UPDATE `usuarios` SET `role` = 'usuario' WHERE `role` IS NULL OR TRIM(`role`) = ''");

  const [unknownRoles] = await conn.query<RowDataPacket[]>(
    `SELECT id, email, role FROM \`usuarios\` WHERE \`role\` NOT IN (${ALLOWED_KNOWN_ROLES.map(() => '?').join(', ')})`,
    [...ALLOWED_KNOWN_ROLES]
  );

  if (unknownRoles.length > 0) {
    const detalhes = unknownRoles.map((r) => `id=${String(r.id)} (${String(r.role)})`).join(', ');
    throw new Error(
      `Papel(is) desconhecido(s) encontrado(s) em usuarios: ${detalhes}. Migração abortada para evitar conversão silenciosa.`
    );
  }

  await conn.query("UPDATE `usuarios` SET `role` = 'pesquisador' WHERE `role` = 'usuario'");
  await conn.query("UPDATE `usuarios` SET `role` = 'curador' WHERE `role` = 'editor'");
  await conn.query("ALTER TABLE `usuarios` MODIFY COLUMN `role` VARCHAR(20) NOT NULL DEFAULT 'pesquisador'");
}

/**
 * REV-04: Na transição para o MangaCloud (executada uma única vez na aplicação de 002_dominio_mangacloud),
 * converte todos os papéis legados não-admin conhecidos ('usuario', 'editor', 'pesquisador', 'curador' legado,
 * 'cliente', 'barbeiro') para 'leitor', preservando apenas 'admin'.
 */
export async function migrateRolesToMangaCloud(conn: mysql.Connection): Promise<void> {
  await conn.query("UPDATE `usuarios` SET `role` = 'leitor' WHERE `role` IS NULL OR TRIM(`role`) = ''");

  const [unknownRoles] = await conn.query<RowDataPacket[]>(
    `SELECT id, email, role FROM \`usuarios\` WHERE \`role\` NOT IN (${ALLOWED_KNOWN_ROLES.map(() => '?').join(', ')})`,
    [...ALLOWED_KNOWN_ROLES]
  );

  if (unknownRoles.length > 0) {
    const detalhes = unknownRoles.map((r) => `id=${String(r.id)} (${String(r.role)})`).join(', ');
    throw new Error(
      `Papel(is) desconhecido(s) encontrado(s) em usuarios: ${detalhes}. Migração abortada para evitar conversão silenciosa.`
    );
  }

  const [resConverted] = await conn.query<ResultSetHeader>(
    "UPDATE `usuarios` SET `role` = 'leitor' WHERE `role` IN ('usuario', 'editor', 'pesquisador', 'curador', 'cliente', 'barbeiro')"
  );

  await conn.query("ALTER TABLE `usuarios` MODIFY COLUMN `role` VARCHAR(20) NOT NULL DEFAULT 'leitor'");

  console.log(
    `[Migrate] Transição de papéis MangaCloud aplicada: ${resConverted.affectedRows} conta(s) legada(s) normalizada(s) para 'leitor' (admin preservado).`
  );
}

/**
 * Invariante 1 da Seção 5 de QA: "Banco incompleto não é banco limpo".
 * Se 001_dominio_acervo_tricolor constar em schema_migrations (em qualquer status: applied, failed, running)
 * OU se qualquer tabela do domínio de futebol já existir parcialmente no banco, mantém 001 na fila antes de 002.
 * Somente se 001 não estiver registrada E nenhuma tabela de futebol existir, executa apenas 002_dominio_mangacloud.
 */
export async function resolveEffectiveMigrations(
  conn: mysql.Connection,
  explicitMigrations?: MigrationDefinition[]
): Promise<MigrationDefinition[]> {
  if (explicitMigrations) {
    return explicitMigrations;
  }

  const [migRows] = await conn.query<RowDataPacket[]>(
    'SELECT version, status FROM schema_migrations WHERE version = ?',
    [LEGACY_001_MIGRATION.version]
  );

  const [tableRows] = await conn.query<RowDataPacket[]>('SHOW TABLES');
  const existingTableNames = new Set(
    tableRows.map((row) => String(Object.values(row)[0] ?? '').toLowerCase())
  );

  const hasLegacyFootballTable = LEGACY_FOOTBALL_TABLES.some((tbl) => existingTableNames.has(tbl));
  const hasLegacy001Record = migRows.length > 0;

  if (hasLegacy001Record || hasLegacyFootballTable) {
    if (!hasLegacy001Record && hasLegacyFootballTable) {
      console.log(
        '[Migrate] Detectadas tabelas legadas de futebol sem registro em schema_migrations; incluindo 001_dominio_acervo_tricolor para recuperação segura.'
      );
    }
    return [LEGACY_001_MIGRATION, MANGACLOUD_002_MIGRATION, BILLING_004_MIGRATION];
  }

  return [MANGACLOUD_002_MIGRATION, BILLING_004_MIGRATION];
}

export async function runMigrations(
  explicitMigrations?: MigrationDefinition[]
): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false
  });

  let acquiredLocks: string[] = [];
  let activeMigrationVersion: string | null = null;

  try {
    acquiredLocks = await acquireCoordinationLocks(conn, 10);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(100) NOT NULL PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_at TIMESTAMP NULL DEFAULT NULL,
        checksum VARCHAR(64) NOT NULL,
        error_message TEXT DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const migrationsToRun = await resolveEffectiveMigrations(conn, explicitMigrations);

    for (const migration of migrationsToRun) {
      const sqlPath = resolveDbFilePath(migration.filename);
      const rawSql = fs.readFileSync(sqlPath, 'utf-8');
      const checksum = crypto.createHash('sha256').update(rawSql).digest('hex');

      const [existing] = await conn.query<RowDataPacket[]>(
        'SELECT version, status, checksum FROM schema_migrations WHERE version = ?',
        [migration.version]
      );
      const existingRow = existing[0];

      if (existingRow) {
        const recordedChecksum = String(existingRow.checksum || '');
        const recordedStatus = String(existingRow.status || '');

        if (recordedChecksum !== checksum) {
          throw new Error(
            `Checksum divergente para a migração '${migration.version}': registrado=${recordedChecksum}, arquivo=${checksum}. Não edite uma migração já registrada; crie uma nova versão.`
          );
        }

        if (recordedStatus === 'applied') {
          console.log(
            `[Migrate] Versão '${migration.version}' já está aplicada (checksum=${recordedChecksum.slice(0, 12)}...). Ignorando sem mutação.`
          );
          continue;
        }

        console.log(
          `[Migrate] Recuperando execução incompleta (status='${recordedStatus}') para '${migration.version}'...`
        );
        activeMigrationVersion = migration.version;
        await conn.query(
          "UPDATE schema_migrations SET status = 'running', started_at = CURRENT_TIMESTAMP, error_message = NULL WHERE version = ? AND checksum = ?",
          [migration.version, checksum]
        );
      } else {
        activeMigrationVersion = migration.version;
        await conn.query(
          "INSERT INTO schema_migrations (version, status, checksum) VALUES (?, 'running', ?)",
          [migration.version, checksum]
        );
      }

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

      if (migration.runLegacyUserUpgrade) {
        await ensureUsuariosColumns(conn, 'pesquisador');
        await migrateLegacyRolesToAcervo(conn);
      }

      if (migration.runMangaCloudRoleTransition) {
        await ensureUsuariosColumns(conn, 'leitor');
        await ensureEstantesColumns(conn);
        await migrateRolesToMangaCloud(conn);
      }

      if (process.env.MIGRATE_SIMULATE_FAILURE === '1' || process.argv.includes('--simulate-failure')) {
        throw new Error('Falha simulada intencionalmente para teste de recuperação do runner (MIGRATE_SIMULATE_FAILURE).');
      }

      await conn.query(
        "UPDATE schema_migrations SET status = 'applied', applied_at = CURRENT_TIMESTAMP, error_message = NULL WHERE version = ?",
        [migration.version]
      );
      activeMigrationVersion = null;

      console.log(`[Migrate] Migração '${migration.version}' concluída com sucesso!`);
    }
  } catch (error: any) {
    console.error('[Migrate] ERRO na migração:', error.message);
    if (acquiredLocks.length > 0 && activeMigrationVersion) {
      try {
        await conn.query(
          "UPDATE schema_migrations SET status = 'failed', error_message = ? WHERE version = ?",
          [String(error.message).slice(0, 1000), activeMigrationVersion]
        );
      } catch {
        // Ignora erro secundário
      }
    }
    throw error;
  } finally {
    if (acquiredLocks.length > 0) {
      await releaseCoordinationLocks(conn, acquiredLocks);
    }
    await conn.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
