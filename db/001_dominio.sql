-- =============================================================================
-- Acervo Tricolor — Migração de Domínio (001_dominio.sql)
-- Compatível com base limpa e base existente (preserva contas e dados legados)
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
  role VARCHAR(20) NOT NULL DEFAULT 'pesquisador',
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

-- 2. Acervo Histórico Compartilhado (temporadas, jogadores, temporada_jogadores, campanhas, fontes_temporada)
CREATE TABLE IF NOT EXISTS temporadas (
  id INT(11) NOT NULL AUTO_INCREMENT,
  ano SMALLINT NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  resumo TEXT NOT NULL,
  treinador VARCHAR(150) DEFAULT NULL,
  jogos INT DEFAULT NULL,
  vitorias INT DEFAULT NULL,
  empates INT DEFAULT NULL,
  derrotas INT DEFAULT NULL,
  gols_marcados INT DEFAULT NULL,
  gols_sofridos INT DEFAULT NULL,
  criterio_estatisticas VARCHAR(255) DEFAULT NULL,
  elenco_completo TINYINT(1) NOT NULL DEFAULT 0,
  observacao_elenco VARCHAR(255) DEFAULT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_temporadas_ano (ano)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS jogadores (
  id INT(11) NOT NULL AUTO_INCREMENT,
  nome VARCHAR(150) NOT NULL,
  posicao VARCHAR(60) NOT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jogador_nome_posicao (nome, posicao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS temporada_jogadores (
  id INT(11) NOT NULL AUTO_INCREMENT,
  temporada_id INT(11) NOT NULL,
  jogador_id INT(11) NOT NULL,
  jogos INT DEFAULT NULL,
  gols INT DEFAULT NULL,
  nota_participacao VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_temporada_jogador (temporada_id, jogador_id),
  KEY idx_tj_jogador (jogador_id),
  CONSTRAINT fk_tj_temporada FOREIGN KEY (temporada_id) REFERENCES temporadas (id) ON DELETE CASCADE,
  CONSTRAINT fk_tj_jogador FOREIGN KEY (jogador_id) REFERENCES jogadores (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campanhas (
  id INT(11) NOT NULL AUTO_INCREMENT,
  temporada_id INT(11) NOT NULL,
  competicao VARCHAR(120) NOT NULL,
  edicao VARCHAR(60) NOT NULL,
  resultado VARCHAR(120) NOT NULL,
  colocacao VARCHAR(80) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_temporada_comp_edicao (temporada_id, competicao, edicao),
  CONSTRAINT fk_campanha_temporada FOREIGN KEY (temporada_id) REFERENCES temporadas (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fontes_temporada (
  id INT(11) NOT NULL AUTO_INCREMENT,
  temporada_id INT(11) NOT NULL,
  titulo_fonte VARCHAR(200) NOT NULL,
  url VARCHAR(500) DEFAULT NULL,
  data_consulta DATE NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_temporada_fonte (temporada_id, titulo_fonte),
  CONSTRAINT fk_fonte_temporada FOREIGN KEY (temporada_id) REFERENCES temporadas (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Recurso Principal Privado (dossies, dossie_temporadas, anexos_dossie)
CREATE TABLE IF NOT EXISTS dossies (
  id INT(11) NOT NULL AUTO_INCREMENT,
  usuario_id INT(11) NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  texto TEXT DEFAULT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dossies_usuario (usuario_id),
  CONSTRAINT fk_dossie_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dossie_temporadas (
  id INT(11) NOT NULL AUTO_INCREMENT,
  dossie_id INT(11) NOT NULL,
  temporada_id INT(11) NOT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dossie_temporada (dossie_id, temporada_id),
  KEY idx_dt_temporada (temporada_id),
  CONSTRAINT fk_dt_dossie FOREIGN KEY (dossie_id) REFERENCES dossies (id) ON DELETE CASCADE,
  CONSTRAINT fk_dt_temporada FOREIGN KEY (temporada_id) REFERENCES temporadas (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS anexos_dossie (
  id INT(11) NOT NULL AUTO_INCREMENT,
  dossie_id INT(11) NOT NULL,
  object_key VARCHAR(255) NOT NULL,
  nome_original VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  tamanho_bytes INT(11) NOT NULL,
  criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_anexo_object_key (object_key),
  KEY idx_anexos_dossie (dossie_id),
  CONSTRAINT fk_anexo_dossie FOREIGN KEY (dossie_id) REFERENCES dossies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
