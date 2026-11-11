-- =============================================================================
-- MangaCloud — Seed Declarativo Idempotente (003_seed_mangacloud.sql)
-- Executado pelo runner seed.ts com controle de lock e preservação de edições
-- =============================================================================

-- Conta demonstrativa de sistema (criada apenas se não existir, sempre como 'leitor')
INSERT IGNORE INTO usuarios (nome, email, senha_hash, role, bio, is_premium)
VALUES (
  'Biblioteca Demonstrativa MangaCloud',
  'demo.biblioteca@mangacloud.local',
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
  'leitor',
  '[SEED-DEMO] Conta demonstrativa oficial do MangaCloud',
  0
);
