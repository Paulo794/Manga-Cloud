-- =============================================================================
-- MangaCloud — Migração de Domínio (002_dominio_mangacloud.sql)
-- Compatível com base limpa e com atualização incremental de base legada
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) NOT NULL PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMP NULL DEFAULT NULL,
  checksum VARCHAR(64) NOT NULL,
  error_message TEXT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1. Base de Autenticação e Perfil (usuarios e reset_tokens)
CREATE TABLE IF NOT EXISTS usuarios (
  id INT(11) NOT NULL AUTO_INCREMENT,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  role VARCHAR(20) NOT NULL DEFAULT 'leitor',
  bio TEXT DEFAULT NULL,
  avatar_url VARCHAR(500) DEFAULT NULL,
  is_premium TINYINT(1) DEFAULT 0,
  stripe_customer_id VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reset_tokens (
  token VARCHAR(100) NOT NULL,
  usuario_id INT(11) NOT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  expira_em TIMESTAMP NOT NULL,
  usado TINYINT(1) DEFAULT 0,
  PRIMARY KEY (token),
  KEY usuario_id (usuario_id),
  CONSTRAINT fk_reset_tokens_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Recurso Principal Privado: Estantes Pessoais, Itens e Capas (MinIO)
CREATE TABLE IF NOT EXISTS estantes (
  id INT(11) NOT NULL AUTO_INCREMENT,
  usuario_id INT(11) NOT NULL,
  seed_key VARCHAR(64) DEFAULT NULL,
  nome VARCHAR(100) NOT NULL,
  descricao VARCHAR(1000) DEFAULT NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_estantes_usuario_seed_key (usuario_id, seed_key),
  KEY idx_estantes_usuario_atualizado (usuario_id, atualizado_em),
  CONSTRAINT fk_estante_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS estante_itens (
  id INT(11) NOT NULL AUTO_INCREMENT,
  estante_id INT(11) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  manga_id VARCHAR(100) NOT NULL,
  ordem INT(11) NOT NULL DEFAULT 0,
  adicionado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_estante_provider_manga (estante_id, provider, manga_id),
  KEY idx_estante_itens_ordem (estante_id, ordem, id),
  CONSTRAINT fk_estante_item_estante FOREIGN KEY (estante_id) REFERENCES estantes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS estante_capas (
  id INT(11) NOT NULL AUTO_INCREMENT,
  estante_id INT(11) NOT NULL,
  object_key VARCHAR(255) NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  tamanho_bytes INT UNSIGNED NOT NULL,
  largura_px SMALLINT UNSIGNED NOT NULL,
  altura_px SMALLINT UNSIGNED NOT NULL,
  nome_original VARCHAR(255) NOT NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_estante_capa (estante_id),
  UNIQUE KEY uk_capa_object_key (object_key),
  CONSTRAINT fk_estante_capa_estante FOREIGN KEY (estante_id) REFERENCES estantes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS minio_objetos_pendentes_remocao (
  id INT(11) NOT NULL AUTO_INCREMENT,
  bucket VARCHAR(100) NOT NULL,
  object_key VARCHAR(255) NOT NULL,
  motivo VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  ultimo_erro VARCHAR(500) DEFAULT NULL,
  proxima_tentativa_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pending_bucket_key (bucket, object_key),
  KEY idx_pending_status_next (status, proxima_tentativa_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Favoritos e Progresso de Leitura Versionado
CREATE TABLE IF NOT EXISTS favoritos_manga (
  id INT(11) NOT NULL AUTO_INCREMENT,
  usuario_id INT(11) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  manga_id VARCHAR(100) NOT NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_favorito_usuario_manga (usuario_id, provider, manga_id),
  KEY idx_favoritos_usuario_criado (usuario_id, criado_em),
  CONSTRAINT fk_favorito_manga_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS progresso_leitura (
  id INT(11) NOT NULL AUTO_INCREMENT,
  usuario_id INT(11) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  manga_id VARCHAR(100) NOT NULL,
  chapter_id VARCHAR(100) NOT NULL,
  idioma VARCHAR(16) NOT NULL DEFAULT 'pt-br',
  pagina INT UNSIGNED NOT NULL DEFAULT 1,
  total_paginas INT UNSIGNED NOT NULL DEFAULT 1,
  revisao INT UNSIGNED NOT NULL DEFAULT 1,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_progresso_usuario_manga_idioma (usuario_id, provider, manga_id, idioma),
  KEY idx_progresso_usuario_atualizado (usuario_id, atualizado_em),
  CONSTRAINT fk_progresso_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Assinaturas Stripe e Idempotência de Webhooks
CREATE TABLE IF NOT EXISTS assinaturas (
  id INT(11) NOT NULL AUTO_INCREMENT,
  usuario_id INT(11) NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  stripe_subscription_id VARCHAR(255) NOT NULL,
  price_id VARCHAR(255) NOT NULL,
  status VARCHAR(40) NOT NULL,
  acesso_ate DATETIME DEFAULT NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  ultimo_evento_stripe_ts BIGINT DEFAULT NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_assinaturas_usuario (usuario_id),
  UNIQUE KEY uk_stripe_subscription (stripe_subscription_id),
  CONSTRAINT fk_assinatura_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stripe_eventos (
  event_id VARCHAR(255) NOT NULL PRIMARY KEY,
  tipo VARCHAR(100) NOT NULL,
  stripe_created_ts BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL,
  erro_mensagem VARCHAR(500) DEFAULT NULL,
  processado_em TIMESTAMP NULL DEFAULT NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
