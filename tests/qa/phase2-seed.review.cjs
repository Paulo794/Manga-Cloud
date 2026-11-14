// Revisão offline do seed: node tests/qa/phase2-seed.review.cjs
// Usa somente conexões falsas; nenhuma SQL é enviada a um servidor.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');

process.env.DOTENV_CONFIG_QUIET = 'true';
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
backendRequire('tsx/cjs');
const mysql = backendRequire('mysql2/promise');
const denyConnection = async () => { throw new Error('QA_OFFLINE_CONNECTIONS_DISABLED'); };
mysql.createConnection = denyConnection;
const { runSeed, MANGACLOUD_DEMO_SHELVES } = backendRequire('./src/migrations/seed.ts');

const qaEnvNames = [
  'QA_LEITOR_EMAIL', 'QA_LEITOR_PASSWORD', 'QA_CURADOR_EMAIL',
  'QA_CURADOR_PASSWORD', 'QA_ADMIN_EMAIL', 'QA_ADMIN_PASSWORD'
];

function makeFixture(bio) {
  const account = { id: 42, email: 'qa-collision@example.invalid', role: 'leitor', bio, senha_hash: 'original-fixture-hash' };
  const statements = [];
  const shelves = new Map(MANGACLOUD_DEMO_SHELVES.map((spec, index) => [spec.seedKey, {
    id: 100 + index, nome: 'Nome editado pelo usuário', descricao: 'Descrição editada pelo usuário'
  }]));
  const conn = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.includes('GET_LOCK')) return [[{ locked: 1 }]];
      if (text.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (text.startsWith('INSERT IGNORE INTO usuarios')) return [{ affectedRows: 0 }];
      if (text === 'SELECT id FROM usuarios WHERE email = ?') return [[{ id: 1 }]];
      if (text.startsWith('SELECT id, nome FROM estantes')) {
        const shelf = shelves.get(params[1]);
        return [shelf ? [{ ...shelf }] : []];
      }
      if (text.startsWith('INSERT IGNORE INTO favoritos_manga')) return [{ affectedRows: 0 }];
      if (text === 'SELECT id, email, role, bio FROM usuarios WHERE email = ?') {
        return [params[0] === account.email ? [{ ...account }] : []];
      }
      if (text === 'UPDATE usuarios SET senha_hash = ?, role = ? WHERE id = ?') {
        assert.equal(params[2], account.id);
        account.senha_hash = params[0];
        account.role = params[1];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`UNHANDLED_MOCK_QUERY: ${text}`);
    },
    async beginTransaction() {}, async commit() {}, async rollback() {}, async end() {}
  };
  return { account, shelves, statements, conn };
}

async function withFixture(fixture, configureQa, callback) {
  const savedEnv = new Map(qaEnvNames.map(name => [name, process.env[name]]));
  try {
    for (const name of qaEnvNames) process.env[name] = '';
    if (configureQa) {
      process.env.QA_ADMIN_EMAIL = fixture.account.email;
      process.env.QA_ADMIN_PASSWORD = 'fixture-only-not-a-real-credential';
    }
    mysql.createConnection = async () => fixture.conn;
    return await callback();
  } finally {
    mysql.createConnection = denyConnection;
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('F2A-01: bio editável não autoriza sobrescrever senha/papel de conta existente', async () => {
  const fixture = makeFixture('[QA-ACCOUNT] Texto colocado pelo próprio usuário');
  await withFixture(fixture, true, async () => {
    try {
      await runSeed();
    } catch (error) {
      // Recusar uma colisão é permitido; falha na infraestrutura do teste não é sucesso.
      if (String(error.message).includes('UNHANDLED_MOCK_QUERY')) throw error;
    }
    assert.equal(fixture.account.role, 'leitor', 'A biografia não é evidência confiável de origem QA');
    assert.equal(fixture.account.senha_hash, 'original-fixture-hash', 'O hash da conta existente deve ser preservado');
  });
});

test('Controle: conta comum sem marcador QA é recusada na colisão de email', async () => {
  const fixture = makeFixture('Biografia comum');
  await withFixture(fixture, true, async () => {
    await assert.rejects(() => runSeed(), /conta n[aã]o-QA existente/i);
    assert.equal(fixture.account.role, 'leitor');
    assert.equal(fixture.account.senha_hash, 'original-fixture-hash');
  });
});

test('Controle: seed_key preserva nome/descrição e não repõe itens de estante existente', async () => {
  const fixture = makeFixture('Biografia comum');
  await withFixture(fixture, false, async () => {
    const result = await runSeed();
    assert.equal(result.insertedShelves, 0);
    assert.equal(result.preservedExistingShelves, MANGACLOUD_DEMO_SHELVES.length);
    assert.equal(result.provisionedQaAccounts, 0);
    assert.equal(fixture.statements.some(sql => /^(INSERT|UPDATE).*\bestantes\b/i.test(sql)), false);
    assert.equal(fixture.statements.some(sql => /^(INSERT|UPDATE).*\bestante_itens\b/i.test(sql)), false);
    for (const shelf of fixture.shelves.values()) {
      assert.equal(shelf.nome, 'Nome editado pelo usuário');
      assert.equal(shelf.descricao, 'Descrição editada pelo usuário');
    }
  });
});
