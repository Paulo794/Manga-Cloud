import assert from 'assert';
import fs from 'fs';
import mysql, { RowDataPacket } from 'mysql2/promise';
import {
  acquireCoordinationLocks,
  COORDINATION_LOCKS,
  LEGACY_001_MIGRATION,
  MANGACLOUD_002_MIGRATION,
  migrateRolesToMangaCloud,
  releaseCoordinationLocks,
  resolveDbFilePath,
  resolveEffectiveMigrations,
  runMigrations
} from './migrate';
import { runSeed } from './seed';

export async function runPhase2UnitSuite(): Promise<void> {
  console.log('=== [Fase 2A — Suíte Unitária e Estática (Mocks/Texto SQL)] ===\n');

  const sql002Path = resolveDbFilePath('002_dominio_mangacloud.sql');
  const sql002 = fs.readFileSync(sql002Path, 'utf-8');

  const requiredTables = [
    'schema_migrations',
    'usuarios',
    'reset_tokens',
    'estantes',
    'estante_itens',
    'estante_capas',
    'minio_objetos_pendentes_remocao',
    'favoritos_manga',
    'progresso_leitura',
    'assinaturas',
    'stripe_eventos'
  ];

  for (const tbl of requiredTables) {
    assert.ok(
      sql002.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`),
      `Tabela obrigatória '${tbl}' deve estar presente em 002_dominio_mangacloud.sql`
    );
  }

  assert.ok(!sql002.includes('titulo_snapshot'), 'REV-07: Não deve persistir titulo_snapshot no schema');
  assert.ok(!sql002.includes('capa_snapshot'), 'REV-07: Não deve persistir capa_snapshot no schema');
  assert.ok(sql002.includes('uk_estantes_usuario_seed_key'), 'Invariante 3: estantes deve ter unique key por (usuario_id, seed_key)');
  assert.ok(sql002.includes('uk_assinaturas_usuario'), 'REV-06: assinaturas deve ter unique key por usuario_id');
  console.log('[OK] 1. Texto DDL de 002_dominio_mangacloud.sql conferido.');

  const lockCalls: string[] = [];
  const fakeConnLockSuccess: any = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('GET_LOCK')) {
        lockCalls.push(`GET:${String(params[0])}`);
        return [[{ locked: 1 }]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        lockCalls.push(`REL:${String(params[0])}`);
        return [[{ released: 1 }]];
      }
      return [[]];
    }
  };

  const acquired = await acquireCoordinationLocks(fakeConnLockSuccess, 5);
  assert.deepStrictEqual(acquired, [...COORDINATION_LOCKS]);
  await releaseCoordinationLocks(fakeConnLockSuccess, acquired);
  assert.deepStrictEqual(lockCalls, [
    'GET:acervo_tricolor_migration_lock',
    'GET:acervo_tricolor_seed_lock',
    'GET:mangacloud_migration_lock',
    'REL:mangacloud_migration_lock',
    'REL:acervo_tricolor_seed_lock',
    'REL:acervo_tricolor_migration_lock'
  ]);
  console.log('[OK] 2. Coordenação simulada dos 3 locks conferida.');

  const cleanDbConn: any = {
    query: async (sql: string) => {
      if (sql.includes('FROM schema_migrations')) return [[]];
      if (sql.includes('SHOW TABLES')) return [[{ Tables_in_db: 'usuarios' }]];
      return [[]];
    }
  };
  const cleanPlan = await resolveEffectiveMigrations(cleanDbConn);
  assert.deepStrictEqual(cleanPlan.map((m) => m.version), [MANGACLOUD_002_MIGRATION.version]);

  const incompleteFootballConn: any = {
    query: async (sql: string) => {
      if (sql.includes('FROM schema_migrations')) return [[]];
      if (sql.includes('SHOW TABLES')) return [[{ Tables_in_db: 'usuarios' }, { Tables_in_db: 'temporadas' }]];
      return [[]];
    }
  };
  const incompletePlan = await resolveEffectiveMigrations(incompleteFootballConn);
  assert.deepStrictEqual(
    incompletePlan.map((m) => m.version),
    [LEGACY_001_MIGRATION.version, MANGACLOUD_002_MIGRATION.version]
  );
  console.log('[OK] 3. Seleção simulada de plano de migração (limpo vs. incompleto) conferida.');

  const roleConnUnknown: any = {
    query: async (sql: string) => {
      if (sql.includes('SELECT id, email, role')) {
        return [[{ id: 99, email: 'x@test.com', role: 'super_hacker' }]];
      }
      return [{ affectedRows: 0 }];
    }
  };
  await assert.rejects(() => migrateRolesToMangaCloud(roleConnUnknown), /Papel\(is\) desconhecido\(s\)/);
  console.log('[OK] 4. Bloqueio simulado de papel desconhecido conferido.');
}

function assertSafeQaDatabaseTarget(host: string, dbPrefix: string): void {
  const allowedHosts = new Set(['127.0.0.1', 'localhost']);
  if (!allowedHosts.has(host)) {
    throw new Error(
      `[SEGURANÇA QA] Recusado executar testes destrutivos de integração fora de localhost (host='${host}').`
    );
  }
  if (!dbPrefix.startsWith('mangacloud_qa_')) {
    throw new Error(
      `[SEGURANÇA QA] Prefixo de banco inválido '${dbPrefix}'. Deve iniciar obrigatoriamente com 'mangacloud_qa_'.`
    );
  }
}

export async function runPhase2MariaDbIntegrationSuite(): Promise<void> {
  console.log('\n=== [Fase 2A — Suíte de Integração Real no MariaDB (Alvo Descartável Exclusivo)] ===\n');

  const qaHost = process.env.QA_DB_HOST || '127.0.0.1';
  const qaPort = Number(process.env.QA_DB_PORT || 33307);
  const qaUser = process.env.QA_DB_USER || 'root';
  const qaPassword = process.env.QA_DB_PASSWORD || 'qa_root_pass';
  const dbClean = 'mangacloud_qa_clean';
  const dbLegacy = 'mangacloud_qa_legacy';
  const dbIncomplete = 'mangacloud_qa_incomplete';

  assertSafeQaDatabaseTarget(qaHost, dbClean);
  assertSafeQaDatabaseTarget(qaHost, dbLegacy);
  assertSafeQaDatabaseTarget(qaHost, dbIncomplete);

  const adminConn = await mysql.createConnection({
    host: qaHost,
    port: qaPort,
    user: qaUser,
    password: qaPassword
  });

  const savedEnv = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
    MIGRATE_SIMULATE_FAILURE: process.env.MIGRATE_SIMULATE_FAILURE,
    QA_LEITOR_EMAIL: process.env.QA_LEITOR_EMAIL,
    QA_LEITOR_PASSWORD: process.env.QA_LEITOR_PASSWORD,
    QA_CURADOR_EMAIL: process.env.QA_CURADOR_EMAIL,
    QA_CURADOR_PASSWORD: process.env.QA_CURADOR_PASSWORD,
    QA_ADMIN_EMAIL: process.env.QA_ADMIN_EMAIL,
    QA_ADMIN_PASSWORD: process.env.QA_ADMIN_PASSWORD
  };

  try {
    process.env.DB_HOST = qaHost;
    process.env.DB_PORT = String(qaPort);
    process.env.DB_USER = qaUser;
    process.env.DB_PASSWORD = qaPassword;

    for (const dbName of [dbClean, dbLegacy, dbIncomplete]) {
      await adminConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await adminConn.query(
        `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    }

    // -------------------------------------------------------------------------
    // Cenário 1: Bootstrap em Banco Limpo + Falha Simulada e Recuperação Real
    // -------------------------------------------------------------------------
    process.env.DB_NAME = dbClean;
    process.env.MIGRATE_SIMULATE_FAILURE = '1';
    await assert.rejects(
      () => runMigrations(),
      /Falha simulada intencionalmente/,
      'Deve falhar quando MIGRATE_SIMULATE_FAILURE=1'
    );

    await adminConn.changeUser({ database: dbClean });
    const [failedRows] = await adminConn.query<RowDataPacket[]>(
      "SELECT version, status FROM schema_migrations WHERE version = '002_dominio_mangacloud'"
    );
    assert.strictEqual(failedRows[0]?.status, 'failed', 'Deve registrar status=failed após erro');

    delete process.env.MIGRATE_SIMULATE_FAILURE;
    await runMigrations();

    const [appliedRows] = await adminConn.query<RowDataPacket[]>(
      'SELECT version, status FROM schema_migrations'
    );
    assert.strictEqual(appliedRows.length, 1);
    assert.strictEqual(appliedRows[0]?.version, '002_dominio_mangacloud');
    assert.strictEqual(appliedRows[0]?.status, 'applied');

    const [cleanTables] = await adminConn.query<RowDataPacket[]>('SHOW TABLES');
    const cleanTableSet = new Set(cleanTables.map((r) => String(Object.values(r)[0])));
    assert.strictEqual(cleanTableSet.has('temporadas'), false, 'Banco limpo não deve criar tabela de futebol');
    assert.strictEqual(cleanTableSet.has('estantes'), true);
    assert.strictEqual(cleanTableSet.has('estante_itens'), true);
    assert.strictEqual(cleanTableSet.has('estante_capas'), true);
    console.log('[OK] Int-1 & Int-9: Bootstrap em banco limpo + falha simulada (status=failed) + recuperação real validados.');

    // -------------------------------------------------------------------------
    // Cenário 2 & 4: Cópia de Schema Legado, Preservação de Contas e Reexecução (curador preservado)
    // -------------------------------------------------------------------------
    process.env.DB_NAME = dbLegacy;
    await adminConn.changeUser({ database: dbLegacy });

    await adminConn.query(`
      CREATE TABLE usuarios (
        id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'usuario',
        bio TEXT DEFAULT NULL,
        avatar_url VARCHAR(500) DEFAULT NULL,
        is_premium TINYINT(1) DEFAULT 0,
        stripe_customer_id VARCHAR(255) DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await adminConn.query(`
      INSERT INTO usuarios (id, nome, email, senha_hash, role, bio, stripe_customer_id) VALUES
      (10, 'Usuario Antigo', 'u10@legacy.invalid', 'hash_u10', 'usuario', 'Bio 10', 'cus_10'),
      (11, 'Editor Antigo', 'u11@legacy.invalid', 'hash_u11', 'editor', 'Bio 11', 'cus_11'),
      (12, 'Admin Antigo', 'u12@legacy.invalid', 'hash_u12', 'admin', 'Bio 12', 'cus_12')
    `);

    // Aplicar 001 primeiro para simular banco legado com 001 registrada
    await runMigrations([LEGACY_001_MIGRATION]);

    // Agora rodar runMigrations() padrão (deve preservar 001 e aplicar 002)
    await runMigrations();

    const [legacyUsers] = await adminConn.query<RowDataPacket[]>(
      'SELECT id, email, senha_hash, role, bio, stripe_customer_id FROM usuarios ORDER BY id ASC'
    );
    assert.deepStrictEqual(
      legacyUsers.map((u) => ({
        id: Number(u.id),
        role: String(u.role),
        hash: String(u.senha_hash),
        stripe: String(u.stripe_customer_id)
      })),
      [
        { id: 10, role: 'leitor', hash: 'hash_u10', stripe: 'cus_10' },
        { id: 11, role: 'leitor', hash: 'hash_u11', stripe: 'cus_11' },
        { id: 12, role: 'admin', hash: 'hash_u12', stripe: 'cus_12' }
      ],
      'Deve converter usuario/editor/curador legado para leitor e preservar admin, IDs, hashes e vínculos Stripe'
    );

    // Promover id=11 para curador do MangaCloud e reexecutar runMigrations(): NÃO deve rebaixar!
    await adminConn.query("UPDATE usuarios SET role = 'curador' WHERE id = 11");
    await runMigrations();
    const [afterRerun] = await adminConn.query<RowDataPacket[]>('SELECT role FROM usuarios WHERE id = 11');
    assert.strictEqual(afterRerun[0]?.role, 'curador', 'Curador promovido após 002 deve permanecer curador na reexecução');
    console.log('[OK] Int-2 & Int-4: Upgrade de banco legado, preservação de contas/admin e preservação de curador após reexecução validados.');

    // -------------------------------------------------------------------------
    // Cenário 3: Legado parcial (tabela de futebol órfã sem registro em schema_migrations)
    // -------------------------------------------------------------------------
    process.env.DB_NAME = dbIncomplete;
    await adminConn.changeUser({ database: dbIncomplete });
    await adminConn.query('CREATE TABLE temporadas (id INT PRIMARY KEY, ano SMALLINT NOT NULL, titulo VARCHAR(180) NOT NULL, resumo TEXT NOT NULL)');
    await runMigrations();
    const [incMigs] = await adminConn.query<RowDataPacket[]>(
      'SELECT version, status FROM schema_migrations ORDER BY version ASC'
    );
    assert.deepStrictEqual(
      incMigs.map((m) => ({ v: String(m.version), s: String(m.status) })),
      [
        { v: '001_dominio_acervo_tricolor', s: 'applied' },
        { v: '002_dominio_mangacloud', s: 'applied' }
      ]
    );
    console.log('[OK] Int-3: Recuperação de banco legado parcial (tabela temporadas pré-existente sem registro 001) validada.');

    // -------------------------------------------------------------------------
    // Cenário 5: Seed repetido, preservação de edições e proteção F2A-01 no MariaDB real
    // -------------------------------------------------------------------------
    process.env.DB_NAME = dbClean;
    await adminConn.changeUser({ database: dbClean });
    process.env.QA_LEITOR_EMAIL = 'leitor.qa@mangacloud.qa.local';
    process.env.QA_LEITOR_PASSWORD = 'QaPassword123!';
    process.env.QA_CURADOR_EMAIL = 'curador.qa@mangacloud.qa.local';
    process.env.QA_CURADOR_PASSWORD = 'QaPassword123!';
    process.env.QA_ADMIN_EMAIL = 'admin.qa@mangacloud.qa.local';
    process.env.QA_ADMIN_PASSWORD = 'QaPassword123!';

    const seedRun1 = await runSeed();
    assert.strictEqual(seedRun1.insertedShelves, 2);
    assert.strictEqual(seedRun1.preservedExistingShelves, 0);
    assert.strictEqual(seedRun1.provisionedQaAccounts, 3);

    // Editar o nome da estante seed_estante_shounen e apagar 1 item dela
    await adminConn.query(
      "UPDATE estantes SET nome = 'Meu Shounen Customizado', descricao = 'Editada pelo leitor' WHERE seed_key = 'seed_estante_shounen'"
    );
    await adminConn.query(
      "DELETE FROM estante_itens WHERE manga_id = 'demo-cyber-ronin'"
    );

    const seedRun2 = await runSeed();
    assert.strictEqual(seedRun2.insertedShelves, 0);
    assert.strictEqual(seedRun2.preservedExistingShelves, 2);
    assert.strictEqual(seedRun2.provisionedQaAccounts, 3);

    const [editedShelf] = await adminConn.query<RowDataPacket[]>(
      "SELECT id, nome, descricao FROM estantes WHERE seed_key = 'seed_estante_shounen'"
    );
    assert.strictEqual(editedShelf[0]?.nome, 'Meu Shounen Customizado');
    assert.strictEqual(editedShelf[0]?.descricao, 'Editada pelo leitor');

    const [remainingItems] = await adminConn.query<RowDataPacket[]>(
      'SELECT manga_id FROM estante_itens WHERE estante_id = ?',
      [editedShelf[0]?.id]
    );
    assert.strictEqual(remainingItems.length, 1, 'Item removido pelo usuário não deve ser recriado pelo seed');

    // Testar F2A-01 no banco real: criar usuário comum com bio forjada '[QA-ACCOUNT]' ou '[QA-PROVISIONED:falso]' e apontar QA_ADMIN_EMAIL para ele
    await adminConn.query(
      "INSERT INTO usuarios (nome, email, senha_hash, role, bio) VALUES ('Impostor', 'impostor@mangacloud.qa.local', 'hash_intacto', 'leitor', '[QA-PROVISIONED:forjado] Bio falsa')"
    );
    process.env.QA_ADMIN_EMAIL = 'impostor@mangacloud.qa.local';
    await assert.rejects(
      () => runSeed(),
      /conta n[aã]o-QA existente/i,
      'MariaDB real: seed deve recusar promover conta com bio forjada'
    );
    const [impostorRows] = await adminConn.query<RowDataPacket[]>(
      "SELECT role, senha_hash FROM usuarios WHERE email = 'impostor@mangacloud.qa.local'"
    );
    assert.strictEqual(impostorRows[0]?.role, 'leitor');
    assert.strictEqual(impostorRows[0]?.senha_hash, 'hash_intacto');
    console.log('[OK] Int-5: Seed idempotente, preservação de nome/itens editados e bloqueio real de F2A-01 validados no MariaDB.');

    // -------------------------------------------------------------------------
    // Cenário 6: FKs e Unicidades reais no MariaDB
    // -------------------------------------------------------------------------
    const shelfId = Number(editedShelf[0]?.id);
    const [ownerRows] = await adminConn.query<RowDataPacket[]>(
      "SELECT id FROM usuarios WHERE email = 'demo.biblioteca@mangacloud.local'"
    );
    const demoUserId = Number(ownerRows[0]?.id);

    // 6a. FK órfã em estantes
    await assert.rejects(
      () => adminConn.query("INSERT INTO estantes (usuario_id, nome) VALUES (999999, 'Orfa')"),
      (err: any) => err.code === 'ER_NO_REFERENCED_ROW_2'
    );
    // 6b. Item duplicado na mesma estante
    await assert.rejects(
      () =>
        adminConn.query(
          "INSERT INTO estante_itens (estante_id, provider, manga_id) VALUES (?, 'demo', 'demo-alquimia-astral')",
          [shelfId]
        ),
      (err: any) => err.code === 'ER_DUP_ENTRY'
    );
    // 6c. Segunda capa para a mesma estante
    await adminConn.query(
      "INSERT INTO estante_capas (estante_id, object_key, mime_type, tamanho_bytes, largura_px, altura_px, nome_original) VALUES (?, 'capas/k1.png', 'image/png', 1024, 200, 300, 'c1.png')",
      [shelfId]
    );
    await assert.rejects(
      () =>
        adminConn.query(
          "INSERT INTO estante_capas (estante_id, object_key, mime_type, tamanho_bytes, largura_px, altura_px, nome_original) VALUES (?, 'capas/k2.png', 'image/png', 1024, 200, 300, 'c2.png')",
          [shelfId]
        ),
      (err: any) => err.code === 'ER_DUP_ENTRY'
    );
    // 6d. Segunda assinatura para o mesmo usuário
    await adminConn.query(
      "INSERT INTO assinaturas (usuario_id, stripe_customer_id, stripe_subscription_id, price_id, status) VALUES (?, 'cus_1', 'sub_1', 'price_1', 'active')",
      [demoUserId]
    );
    await assert.rejects(
      () =>
        adminConn.query(
          "INSERT INTO assinaturas (usuario_id, stripe_customer_id, stripe_subscription_id, price_id, status) VALUES (?, 'cus_1', 'sub_2', 'price_1', 'active')",
          [demoUserId]
        ),
      (err: any) => err.code === 'ER_DUP_ENTRY'
    );
    console.log('[OK] Int-6: Constraints reais do MariaDB (FK órfã, item duplicado, 2ª capa e 2ª assinatura por usuário) validadas.');

    // -------------------------------------------------------------------------
    // Cenário 7: Checksum divergente aborta sem sobrescrever registro
    // -------------------------------------------------------------------------
    await adminConn.query(
      "UPDATE schema_migrations SET checksum = '0000000000000000000000000000000000000000000000000000000000000000' WHERE version = '002_dominio_mangacloud'"
    );
    await assert.rejects(() => runMigrations(), /Checksum divergente/);
    const [chkRows] = await adminConn.query<RowDataPacket[]>(
      "SELECT status, checksum FROM schema_migrations WHERE version = '002_dominio_mangacloud'"
    );
    assert.strictEqual(chkRows[0]?.status, 'applied');
    assert.strictEqual(
      chkRows[0]?.checksum,
      '0000000000000000000000000000000000000000000000000000000000000000',
      'Checksum divergente não deve ser sobrescrito silenciosamente'
    );
    console.log('[OK] Int-7: Proteção contra checksum divergente validada no MariaDB.');

    // -------------------------------------------------------------------------
    // Cenário 8: Disputa real de lock entre duas conexões MariaDB distintas
    // -------------------------------------------------------------------------
    const rivalConn = await mysql.createConnection({
      host: qaHost,
      port: qaPort,
      user: qaUser,
      password: qaPassword,
      database: dbClean
    });
    try {
      await rivalConn.query("SELECT GET_LOCK('acervo_tricolor_seed_lock', 5)");
      await assert.rejects(
        () => acquireCoordinationLocks(adminConn, 1),
        /Não foi possível adquirir o lock 'acervo_tricolor_seed_lock'/
      );
      // Confirmar que o 1º lock ('acervo_tricolor_migration_lock') foi liberado no rollback
      const [freeCheck] = await rivalConn.query<RowDataPacket[]>(
        "SELECT IS_FREE_LOCK('acervo_tricolor_migration_lock') AS isFree"
      );
      assert.strictEqual(Number(freeCheck[0]?.isFree), 1, '1º lock deve ser liberado quando o 2º falha');
    } finally {
      await rivalConn.query("SELECT RELEASE_LOCK('acervo_tricolor_seed_lock')");
      await rivalConn.end();
    }
    console.log('[OK] Int-8: Disputa real de locks entre conexões concorrentes e rollback de lock parcial validados.');
  } finally {
    for (const dbName of [dbClean, dbLegacy, dbIncomplete]) {
      try {
        await adminConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      } catch {
        // Ignora erro de limpeza
      }
    }
    await adminConn.end();

    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log('\n=== [Fase 2A — INTEGRAÇÃO REAL MARIADB CONCLUÍDA COM 100% DE SUCESSO] ===');
}

if (require.main === module) {
  (async () => {
    const runIntegration =
      process.argv.includes('--integration') || process.env.QA_MARIADB_INTEGRATION === '1';
    await runPhase2UnitSuite();
    if (runIntegration) {
      await runPhase2MariaDbIntegrationSuite();
    } else {
      console.log(
        '\n[INFO] Suíte unitária/mockada concluída. Para executar a integração real no MariaDB descartável, use: npx tsx src/migrations/verifyPhase2Db.ts --integration'
      );
    }
  })().catch((err) => {
    console.error('[ERRO Fase 2A]:', err);
    process.exit(1);
  });
}
