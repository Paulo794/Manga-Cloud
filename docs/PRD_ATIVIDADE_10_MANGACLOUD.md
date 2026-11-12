# 📋 PRD — Atividade 10 ("Seu Negócio no Ar"): MangaCloud (v2 — Revisado pós-QA)

- **Produto:** MangaCloud — Biblioteca Pessoal e Leitor Web de Mangás e HQs
- **Disciplina:** Introdução à Computação em Nuvem (ISW055) — Prof. Allan Siriani (`@siriani`)
- **Repositório do Produto:** `https://github.com/Paulo794/Manga-Cloud`
- **Data:** 11/11/2026 (Versão 2 — Incorpora integralmente os achados `REV-01` a `REV-10` de [REVISAO_QA_PRD_ATIVIDADE_10_MANGACLOUD.md](./REVISAO_QA_PRD_ATIVIDADE_10_MANGACLOUD.md))
- **Status:** Especificação técnica de arquitetura, infraestrutura e QA; não declara código, testes ou deploy como já concluídos.

---

## 0. Matriz de Rastreabilidade da Revisão (`REV-01` a `REV-10`)

| ID | Achado da Revisora | Como foi incorporado nesta v2 do PRD |
| :-: | :--- | :--- |
| **REV-01** | Retirar fallback de autorização por `usuarios.is_premium` | **Seção 4.2 e 5.2:** `assinaturas` com validação temporal (`acesso_ate > UTC_TIMESTAMP()`) é a **única** fonte de verdade para Pro. `is_premium` fica restrito a projeção legada e jamais libera capítulos. |
| **REV-02** | Tornar obrigatória a integração real de leitura (MangaDex) separada de `demo` | **Seção 1.1 e 5.1:** Dois provedores explícitos e isolados por namespace (`mangadex` real com aceite próprio de busca $\rightarrow$ obra $\rightarrow$ capítulos $\rightarrow$ páginas, e `demo` sintético para paywall/Stripe/QA), sem fallback silencioso. |
| **REV-03** | Completar estratégia de migração, histórico, versões e lock | **Seção 3.3:** Inventário prévio de `schema_migrations`, preservação do lock mútuo durante transição, caminho limpo vs. incremental legado sem obrigar domínio de futebol, serialização de `migrate`/`seed` e cópia de `db/` na imagem Docker. |
| **REV-04** | Evitar transferência automática de privilégios entre negócios | **Seção 3.1 e 4.2:** Transição converte `usuario`/`pesquisador`/`editor`/`curador` legado em `leitor` (preservando só `admin`) uma única vez via versão registrada, sem rebaixar curadores promovidos depois no MangaCloud. |
| **REV-05** | Definir atualização atômica de progresso por revisão e validação no provedor | **Seção 5.4:** `UPDATE ... WHERE ... AND revisao = ?` atômico com `affectedRows === 0` $\rightarrow$ `409 Conflict`; `total_paginas` e vínculo capítulo/obra obtidos do provedor no servidor. |
| **REV-06** | Detalhar estados, transação, concorrência e idempotência do ciclo Stripe | **Seção 3.2 e 5.5:** Unicidade de assinatura vigente por usuário, processamento transacional `stripe_eventos` + `assinaturas`, retentativa permitida para `failed`, reconciliação contra eventos fora de ordem e política explícita para `past_due`/`canceled`. |
| **REV-07** | Resolver snapshots vs. "somente referências locais" | **Seção 3.2:** Removidos `titulo_snapshot` e `capa_snapshot` do banco; `estante_itens` e `favoritos_manga` guardam apenas `provider + manga_id`, com hidratação em lote e estado explícito `"Metadados temporariamente indisponíveis"` se a API externa falhar. |
| **REV-08** | Fechar identidade de provedor nas rotas, paginação e capítulo canônico global | **Seção 5.1 e 5.2:** Namespace `:provider` (`mangadex` \| `demo`) explícito nas rotas; canonização calculada sobre o conjunto completo de capítulos da obra/idioma; regra das **3 primeiras posições canônicas** (ex.: `1, 2, 2.5` bloqueando `3`). |
| **REV-09** | Completar validação de imagem (decodificação/dimensões) e compensação MinIO $\leftrightarrow$ SQL | **Seção 3.2 e 5.3:** Checagem de dono antes do upload, validação de dimensões/pixels reais da imagem, lock por estante e tabela `minio_objetos_pendentes_remocao` para nunca perder chaves em cascata SQL ou falha parcial. |
| **REV-10** | Separar "build local" de "negócio no ar", escopo de limpeza e nova ordem de execução | **Seção 7, 8 e 9:** Checklist completo de implantação pública no Portainer, 7 prints obrigatórios, escopo seguro de remoção de TMDB/filmes e execução reorganizada em 6 fases priorizando o núcleo da Atividade 10. |

---

## 1. Visão Geral e Escopo da Atividade 10

Na **Atividade 10**, o sistema deixa de servir ao catálogo de filmes do Tom Hanks (TMDB) e passa a operar o domínio do **MangaCloud** na **mesma stack do Portainer, mesmos containers, mesmos limites efetivos (1 GB de RAM por container) e mesmo subdomínio**.

### 1.1. Decisões Estruturais do Produto
1. **Recurso Principal do Negócio (CRUD Obrigatório + Isolamento):**
   - **Estantes Pessoais (`estantes`)**, seus **Itens (`estante_itens`)** e **Capa Personalizada (`estante_capas`)** no MinIO, acompanhados de **Favoritos (`favoritos_manga`)**.
   - Todo usuário autenticado (`leitor`, `curador`, `admin`) tem acesso integral ao CRUD de suas próprias estantes e capas no plano **Free** (sem ocultar o CRUD atrás do paywall).
2. **Dois Contextos Explícitos de Provedor (`mangadex` Real + `demo` Determinístico — `REV-02`):**
   - **`provider = 'mangadex'` (Leitura Real Obrigatória):** Integração real com a API pública do MangaDex (`https://api.mangadex.org` e `/at-home/server/:chapterId`) permitindo buscar obras reais, abrir detalhes, listar capítulos por idioma (`pt-br` padrão com opção de troca explícita para `en` ou outros idiomas disponíveis quando não houver tradução em `pt-br`) e ler as páginas reais no Web Reader. Respeitando a Acceptable Usage Policy do MangaDex, o contexto `mangadex` **não** aplica cobrança comercial sobre a API pública e **nunca** faz fallback silencioso para fixtures em caso de erro de rede.
   - **`provider = 'demo'` (Fixtures Determinísticas para Paywall, Stripe Teste e Suíte QA):** Conjunto determinístico de obras sintéticas/próprias (com no mínimo 4 capítulos, incluindo numeração decimal `1, 2, 2.5, 3`, traduções duplicadas e obra sem tradução) servido pelo adaptador local fora do banco e do MinIO do usuário. Sobre o contexto `demo` aplicam-se a demonstração comercial do Paywall (3 primeiras posições canônicas no Free vs. acesso completo no Pro) e os testes do ciclo de assinatura Stripe em modo de teste.
   - **Isolamento de Identidades:** Todas as rotas, tabelas e links qualificam a referência pelo par `(provider, manga_id)` e `(provider, chapter_id)`, impedindo qualquer colisão entre obras reais do MangaDex e obras demonstrativas.
3. **Separação entre Papéis de Negócio (RBAC) e Planos de Assinatura (Entitlement):**
   - **Papéis (`role` no `auth-service`):** `leitor`, `curador` e `admin`.
   - **Planos comerciais:** `Free` e `Pro` (controlados exclusivamente pela tabela `assinaturas` e prazo de vigência confirmado).

---

## 2. Mapeamento dos 10 Requisitos Obrigatórios da Atividade 10

| # | Requisito da Atividade 10 | Especificação Técnica no MangaCloud |
| :-: | :--- | :--- |
| **1** | **Stack aponta para o repositório novo** | Stack existente no Portainer atualizada para `Paulo794/Manga-Cloud`, mantendo subdomínio, portas, volumes e limite efetivo de 1 GB RAM por container. |
| **2** | **Modelagem no MariaDB (`db/`)** | Mínimo de 3 tabelas novas do domínio ligadas por FKs (`estantes`, `estante_itens`, `estante_capas`) + tabelas de suporte (`favoritos_manga`, `progresso_leitura`, `assinaturas`, `stripe_eventos`, `minio_objetos_pendentes_remocao`), com scripts versionados de migration e seed idempotente. |
| **3** | **API própria com CRUD + Swagger** | CRUD completo de estantes, itens e capas (`/api/estantes`), favoritos (`/api/favoritos`), catálogo e capítulos por provedor (`/api/mangas/:provider/*`), manifesto de leitura (`/api/leitura/:provider/:chapterId/manifesto`), progresso (`/api/progresso`), curadoria (`/api/curadoria/integracao`) e OpenAPI em `/api-docs`. |
| **4** | **Telas do recurso principal** | Interface React completa acessível a contas Free: Landing Page, Catálogo (`mangadex` e `demo`), Detalhe da Obra, Web Reader, Minhas Estantes (listar, criar, detalhar, editar, excluir e gerir capa), Favoritos/Histórico, Painel de Curadoria e Painel Admin. |
| **5** | **Papéis do negócio (`3+ papéis`)** | `leitor` (padrão no cadastro), `curador` (diagnóstico técnico de integração/cobertura) e `admin` (gestão de papéis e consulta de logs). Chamadas diretas na API sem o papel exigido retornam `403`. |
| **6** | **Isolamento por usuário (*Multi-tenancy*)** | Escopo por `usuario_id` do JWT em `estantes`, `favoritos_manga` e `progresso_leitura`, e por `JOIN` obrigatório com `estantes.usuario_id` em `estante_itens` e `estante_capas` (leitura, escrita, upload, download e exclusão). Acesso a recurso de terceiro retorna `404`. |
| **7** | **Eventos de negócio no `log-service`** | Auditoria no Redis Streams exibindo no painel admin ator, instante UTC, recurso e resultado para `estante.*`, `favorito.*`, `leitura.liberada`, `leitura.bloqueada`, `progresso.atualizado`, `assinatura.atualizada` e `usuario.papel_alterado`, preservando eventos de login e erro. |
| **8** | **MinIO ligado ao domínio** | Upload de **capa personalizada da estante** em bucket privado (`mangacloud-capas`), vinculado a `estante_capas`, com validação estrutural de imagem e compensação de objetos órfãos. |
| **9** | **Landing page pública (`/`)** | Página aberta sem sessão apresentando a proposta de valor do MangaCloud e botão funcional para criar conta/entrar no subdomínio público. |
| **10** | **Nada de Tom Hanks / TMDB** | Retirada de rotas `/api/movies`, `TMDB_API_KEY`, textos e componentes de filmes do código ativo e das telas, com escopo seguro documentado na Seção 8. |

---

## 3. Modelagem de Dados (MariaDB), Migração e Preservação (`REV-03`, `REV-04`, `REV-07`, `REV-09`)

### 3.1. Adaptação da Tabela `usuarios` e Regra de Transição de Papéis (`REV-04`)
- Preservar integralmente `id`, `nome`, `email`, `senha_hash`, `bio`, `avatar_url`, `stripe_customer_id` e `criado_em`.
- **Não transferir privilégios de negócios anteriores (`REV-04`):**
  - Na migração de transição para o MangaCloud (executada **uma única vez** quando a versão `002_dominio_mangacloud` é aplicada), todos os papéis legados não-administrativos conhecidos (`usuario`, `pesquisador`, `editor`, `curador` legado do domínio anterior, `cliente`, `barbeiro`) são convertidos para `'leitor'`, preservando apenas `'admin'`.
  - Caso exista algum valor de `role` desconhecido fora dessa lista, a migração aborta antes de alterar dados e emite diagnóstico explícito.
  - A coluna `usuarios.role` passa a ter `DEFAULT 'leitor'`.
  - Como essa conversão fica vinculada exclusivamente à aplicação única da migration `002_dominio_mangacloud` registrada em `schema_migrations`, reexecuções futuras de `npm run db:migrate` **jamais** rebaixam um `curador` promovido posteriormente dentro do MangaCloud.
  - Promoções para `curador` no MangaCloud ocorrem exclusivamente por ação administrativa explícita (`PATCH /api/admin/usuarios/:id/papel`) ou pelo seed controlado de contas de demonstração/QA.

### 3.2. Tabelas do Domínio (`InnoDB`, `utf8mb4_unicode_ci`)

> **Decisão `REV-07` (Somente Referências Locais):** `estante_itens` e `favoritos_manga` armazenam **apenas** `provider` e `manga_id` (sem `titulo_snapshot` nem `capa_snapshot`), mantendo fidelidade estrita ao princípio de não persistir catálogo externo no banco local. Quando o provedor externo estiver indisponível, a API retorna os itens da estante com `metadataAvailable: false` e rótulo temporário, permitindo continuar editando/excluindo a estante ou removendo o item normalmente.

1. **`estantes`** (Recurso Principal)
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `usuario_id` INT NOT NULL (FK $\rightarrow$ `usuarios(id)` ON DELETE CASCADE)
   - `nome` VARCHAR(100) NOT NULL
   - `descricao` VARCHAR(1000) DEFAULT NULL
   - `criado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   - `atualizado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   - Índice: `idx_estantes_usuario_atualizado (usuario_id, atualizado_em DESC)`

2. **`estante_itens`** (Relação Estante $\leftrightarrow$ Referência Opaca Externa)
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `estante_id` INT NOT NULL (FK $\rightarrow$ `estantes(id)` ON DELETE CASCADE)
   - `provider` VARCHAR(32) NOT NULL
   - `manga_id` VARCHAR(100) NOT NULL
   - `ordem` INT NOT NULL DEFAULT 0
   - `adicionado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   - Constraint: `UNIQUE KEY uk_estante_provider_manga (estante_id, provider, manga_id)`

3. **`estante_capas`** (Vínculo 1:1 com Objeto Privado no MinIO)
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `estante_id` INT NOT NULL (FK $\rightarrow$ `estantes(id)` ON DELETE CASCADE)
   - `object_key` VARCHAR(255) NOT NULL
   - `mime_type` VARCHAR(50) NOT NULL
   - `tamanho_bytes` INT UNSIGNED NOT NULL
   - `largura_px` SMALLINT UNSIGNED NOT NULL
   - `altura_px` SMALLINT UNSIGNED NOT NULL
   - `nome_original` VARCHAR(255) NOT NULL
   - `criado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   - Constraints: `UNIQUE KEY uk_estante_capa (estante_id)`, `UNIQUE KEY uk_capa_object_key (object_key)`

4. **`minio_objetos_pendentes_remocao`** (Compensação de Limpeza MinIO $\leftrightarrow$ SQL — `REV-09`)
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `bucket` VARCHAR(100) NOT NULL
   - `object_key` VARCHAR(255) NOT NULL
   - `motivo` VARCHAR(100) NOT NULL *(`estante_excluida`, `capa_substituida`, `capa_removida`, `rollback_upload`)*
   - `tentativas` SMALLINT UNSIGNED NOT NULL DEFAULT 0
   - `ultimo_erro` VARCHAR(500) DEFAULT NULL
   - `criado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   - Constraint: `UNIQUE KEY uk_pending_bucket_key (bucket, object_key)`

5. **`favoritos_manga`**
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `usuario_id` INT NOT NULL (FK $\rightarrow$ `usuarios(id)` ON DELETE CASCADE)
   - `provider` VARCHAR(32) NOT NULL
   - `manga_id` VARCHAR(100) NOT NULL
   - `criado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   - Constraint: `UNIQUE KEY uk_favorito_usuario_manga (usuario_id, provider, manga_id)`

6. **`progresso_leitura`**
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `usuario_id` INT NOT NULL (FK $\rightarrow$ `usuarios(id)` ON DELETE CASCADE)
   - `provider` VARCHAR(32) NOT NULL
   - `manga_id` VARCHAR(100) NOT NULL
   - `chapter_id` VARCHAR(100) NOT NULL
   - `idioma` VARCHAR(16) NOT NULL DEFAULT `'pt-br'`
   - `pagina` INT UNSIGNED NOT NULL DEFAULT 1
   - `total_paginas` INT UNSIGNED NOT NULL DEFAULT 1
   - `revisao` INT UNSIGNED NOT NULL DEFAULT 1
   - `atualizado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   - Constraint: `UNIQUE KEY uk_progresso_usuario_manga_idioma (usuario_id, provider, manga_id, idioma)`

7. **`assinaturas`** (`REV-01`, `REV-06`)
   - `id` INT AUTO_INCREMENT PRIMARY KEY
   - `usuario_id` INT NOT NULL (FK $\rightarrow$ `usuarios(id)` ON DELETE CASCADE)
   - `stripe_customer_id` VARCHAR(255) NOT NULL
   - `stripe_subscription_id` VARCHAR(255) NOT NULL
   - `price_id` VARCHAR(255) NOT NULL
   - `status` VARCHAR(40) NOT NULL *(`active`, `past_due`, `canceled`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`)*
   - `acesso_ate` DATETIME DEFAULT NULL
   - `cancel_at_period_end` TINYINT(1) NOT NULL DEFAULT 0
   - `ultimo_evento_stripe_ts` BIGINT DEFAULT NULL
   - `criado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   - `atualizado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   - Constraints: `UNIQUE KEY uk_assinaturas_usuario (usuario_id)`, `UNIQUE KEY uk_stripe_subscription (stripe_subscription_id)`

8. **`stripe_eventos`** (`REV-06`)
   - `event_id` VARCHAR(255) NOT NULL PRIMARY KEY
   - `tipo` VARCHAR(100) NOT NULL
   - `stripe_created_ts` BIGINT NOT NULL
   - `status` VARCHAR(30) NOT NULL *(`processing`, `processed`, `failed`)*
   - `erro_mensagem` VARCHAR(500) DEFAULT NULL
   - `processado_em` TIMESTAMP NULL DEFAULT NULL
   - `criado_em` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP

### 3.3. Estratégia de Migração, Lock e Seed (`REV-03` e Invariantes QA Seção 5)
1. **Inventário e Convivência com Versões Aplicadas (Banco Incompleto $\neq$ Banco Limpo):**
   - Antes de aplicar qualquer SQL, `migrate.ts` inspeciona `schema_migrations` e as tabelas existentes no schema (`SHOW TABLES`).
   - **Caminho Legado ou Incompleto:** Se `001_dominio_acervo_tricolor` constar em `schema_migrations` (com `status = 'applied'`, `'failed'` ou `'running'`) **ou** se tabelas legadas de futebol (`temporadas`, `jogadores`, `campanhas`) já existirem parcialmente no banco sem registro `applied`, o runner **não** pula a recuperação: valida checksum e conclui/recupera `001_dominio_acervo_tricolor` antes de aplicar incrementalmente `002_dominio_mangacloud` (`db/002_dominio_mangacloud.sql`).
   - **Caminho Banco Limpo:** Somente quando `001_dominio_acervo_tricolor` não existir em `schema_migrations` **e** nenhuma tabela de futebol existir no schema, o runner garante a tabela base `usuarios` e aplica diretamente `002_dominio_mangacloud` sem exigir criar o domínio de futebol.
2. **Exclusão Mútua Coordenada (`migrate` + `seed` Antigo e Novo):**
   - Tanto `migrate.ts` quanto `seed.ts` adquirem as três chaves de lock em ordem alfabética fixa (`'acervo_tricolor_migration_lock'`, `'acervo_tricolor_seed_lock'`, `'mangacloud_migration_lock'`) e liberam na ordem inversa no bloco `finally`, impedindo concorrência mesmo contra o runner/seed legado.
   - Em caso de falha parcial de DDL, o status em `schema_migrations` fica como `'failed'`, o processo retorna código `!= 0` e a reexecução subsequente retoma de forma segura graças a instruções DDL idempotentes (`CREATE TABLE IF NOT EXISTS` e verificação prévia de colunas/índices).
3. **Seed com Identidade Estável (`seed_key`) e Provisionamento Seguro de QA:**
   - A tabela `estantes` inclui a coluna opcional `seed_key VARCHAR(64) DEFAULT NULL` com constraint `UNIQUE KEY uk_estantes_usuario_seed_key (usuario_id, seed_key)` (estantes criadas por usuários na API têm `seed_key = NULL`, permitindo múltiplas estantes).
   - O seed cria estantes demonstrativas identificadas por `seed_key` estável (ex.: `'demo_shounen'`, `'demo_semanal'`) verificando `WHERE usuario_id = ? AND seed_key = ?`: se o usuário editar posteriormente o `nome` ou `descricao` da estante de seed, reexecutar `npm run db:seed` reconhece a `seed_key` e **não duplica nem sobrescreve** a edição do usuário.
   - O provisionamento de contas de QA (`leitor`, `curador`, `admin`) usa e-mails dedicados de QA configurados via ambiente e verifica antes se o e-mail já pertence a uma conta real: nunca sobrescreve senha ou papel de conta real pré-existente por colisão.
4. **Executor de Limpeza Compensatória do MinIO (`minio_objetos_pendentes_remocao`):**
   - Uma rotina de reconciliação (`processPendingMinioDeletions`) consome registros pendentes com limite máximo de 5 tentativas e backoff exponencial, marcando falhas permanentes para inspeção no diagnóstico `/api/curadoria/integracao`. Se tanto o banco quanto a limpeza imediata de rollback falharem após upload, o erro é registrado na auditoria operacional sem prometer transação distribuída 2PC entre SQL e S3.
5. **Distribuição na Imagem Docker:**
   - O `Dockerfile` raiz passa a copiar explicitamente `COPY db ./db` para `/app/db` (além de `/app/backend`), garantindo que `npm run db:migrate` e `npm run db:seed` funcionem dentro do container em produção.

---

## 4. Papéis (RBAC), Planos e Isolamento (`REV-01`, `REV-04`)

### 4.1. Matriz de Permissões por Papel

| Capacidade / Rota | `leitor` | `curador` | `admin` |
| :--- | :---: | :---: | :---: |
| Navegar no catálogo (`mangadex` e `demo`) e ver detalhes/capítulos | ✅ | ✅ | ✅ |
| CRUD das próprias estantes, itens, capas e favoritos | ✅ | ✅ | ✅ |
| Ler capítulos no provedor `mangadex` (conforme disponibilidade da fonte) | ✅ | ✅ | ✅ |
| Ler capítulos no provedor `demo` (posições canônicas 1–3 no Free; 4+ somente com assinatura Pro vigente) | Conforme assinatura | Conforme assinatura | Conforme assinatura |
| Acessar/editar/excluir estantes, itens ou capas de outro usuário | ❌ (`404`) | ❌ (`404`) | ❌ (`404`) |
| Diagnóstico técnico de integração e cobertura (`/api/curadoria/integracao`) | ❌ (`403`) | ✅ | ✅ |
| Alterar papel de usuário (`PATCH /api/admin/usuarios/:id/papel`) | ❌ (`403`) | ❌ (`403`) | ✅ |
| Consultar trilha de auditoria administrativa (`GET /api/admin/logs`) | ❌ (`403`) | ❌ (`403`) | ✅ |

### 4.2. Regras de Autorização e Revogação Imediata
1. **Cadastro Público Blindado:** `POST /api/auth/register` no `auth-service` ignora qualquer atributo `role`, `is_premium` ou `stripe_customer_id` enviado no payload e grava sempre `role = 'leitor'`.
2. **Autorização de Papel com Revalidação no Banco (`REV-04`):**
   - A alteração de papel (`PATCH /api/admin/usuarios/:id/papel`) é validada e executada verificando no banco se o autor da requisição possui atualmente `role = 'admin'`.
   - Em todas as rotas restritas por papel (`/api/curadoria/*`, `/api/admin/*` e endpoints administrativos do `auth-service`), o middleware consulta o `role` atual do usuário no banco de dados (não confiando apenas na claim `role` de um JWT emitido antes de um eventual rebaixamento). Se o papel atual não tiver permissão, retorna `403 Forbidden` imediatamente.
3. **Fonte Única de Verdade para o Plano Pro (`REV-01`):**
   - O direito ao plano **Pro** é determinado **exclusivamente** pela consulta à tabela `assinaturas` no MariaDB:
     $$\text{isProAtivo} \iff \text{status} = \text{'active'} \text{ AND } \text{acesso\_ate} > \text{UTC\_TIMESTAMP()}$$
   - **Proibição de Fallback em `usuarios.is_premium`:** O campo booleano legado `usuarios.is_premium` pode ser atualizado apenas como projeção secundária para não quebrar telas legadas de perfil, mas **nunca** é consultado como alternativa em `canReadChapter` nem em `PUT /api/progresso`. Se `usuarios.is_premium = 1` mas a linha em `assinaturas` estiver ausente, cancelada após o prazo ou com `acesso_ate <= UTC_TIMESTAMP()`, o acesso Pro é **negado** (`403 PLAN_REQUIRED`). Em caso de erro de banco ao consultar `assinaturas`, o backend retorna erro controlado (`503`) e jamais libera acesso por falha.

---

## 5. Contratos de API, Gatekeeper, Upload e Assinatura

Todas as rotas da API respondem sob `/api`. Qualquer caminho `/api/*` inexistente retorna JSON `404` (`{ code: 'ROUTE_NOT_FOUND', message, requestId }`) **antes** do fallback estático do SPA.

### 5.1. Adaptadores de Catálogo (`mangadex` e `demo`) e Canonização Global (`REV-02`, `REV-08`)
- **Identidade Explícita de Provedor (`REV-08`):**
  - Os provedores válidos pertencem à whitelist estrita `['mangadex', 'demo']`. Qualquer outro valor retorna `400 Bad Request` (`INVALID_PROVIDER`). Nunca aceitar URLs ou hosts arbitrários do cliente (prevenção contra SSRF).
  - Rotas de catálogo e leitura:
    - `GET /api/mangas?provider=mangadex|demo&q=&tag=&idioma=pt-br&page=1&limit=20`
    - `GET /api/mangas/tags?provider=mangadex|demo`
    - `GET /api/mangas/:provider/:mangaId`
    - `GET /api/mangas/:provider/:mangaId/capitulos?idioma=pt-br`
    - `GET /api/leitura/:provider/:chapterId/manifesto`
- **Orçamento de Rede e Resiliência (`mangadex`):**
  - Timeout de **8 segundos** por requisição externa; máximo de **1 retentativa** em erro transitório de `GET` (`502`/`503`/`504`/timeout) com backoff de 400ms e respeito ao header `Retry-After` em respostas `429 Too Many Requests`.
  - Filtro obrigatório `contentRating[]=safe` no backend em todas as buscas, detalhes e capítulos.
  - Se uma obra real no `mangadex` não possuir capítulos em `pt-br`, a API retorna `capitulos: []` junto com `idiomasDisponiveis: [...]` da obra, permitindo ao usuário trocar explicitamente para `en` ou outro idioma disponível na interface (sem misturar idiomas silenciosamente e sem substituir por fixtures `demo`).
- **Regra de Canonização Global de Capítulos (`REV-08`, `F1-01`, `F1-02`, `F1-03`, `F1-04`):**
  - Para determinar a ordem narrativa e as **3 primeiras posições canônicas**, o serviço consome toda a paginação de capítulos da obra no idioma selecionado (sem truncar silenciosamente em 500 registros; se a fonte exceder o teto operacional de 5000 itens ou retornar página vazia antes do total anunciado, retorna erro explícito `502 EXTERNAL_PAGINATION_INCOMPLETE`).
  - Timeout de 8s permanece ativo durante toda a recepção e leitura/parse do corpo JSON (`await response.json()`), abortando respostas lentas e lançando `504 EXTERNAL_PROVIDER_TIMEOUT`.
  - Classificação segura (`contentRating === 'safe'`) deve estar explicitamente presente na obra (sem assumir `'safe'` por default quando o campo estiver ausente).
  - Capítulos numéricos legíveis internamente (incluindo capítulo `0` de prólogo e decimais normalizados textualmente sem perda de precisão) são agrupados pela chave composta **`(volumeNumber explícito, chapterNumber decimal)`** — preservando capítulos de mesmo número em volumes diferentes como entradas distintas (`F1-01`). Entradas sem volume explícito (`volumeNumber = null`) não sofrem deduplicação automática.
  - Quando houver múltiplas traduções para o mesmo `(volume, capítulo)` e idioma, elas compartilham a mesma **posição canônica** (`canonicalPosition`), escolhendo-se de forma determinística (maior contagem de páginas e menor ID) a versão principal e preservando os metadados completos (`title`, `volumeNumber`, `chapterNumber`, `scanlationGroup`, `pagesCount`) nas `alternateTranslations`.
  - **Posição Canônica vs. Número do Capítulo:** No plano Free (contexto `demo`), estão liberadas as **posições canônicas `1`, `2` e `3`**. Exemplo obrigatório de aceite: em uma obra com capítulos `1`, `2`, `2.5` e `3`, as três primeiras posições canônicas são `1` (pos. 1), `2` (pos. 2) e `2.5` (pos. 3), enquanto o capítulo `3` ocupa a **4ª posição canônica** e é bloqueado para o plano Free (`403 PLAN_REQUIRED`).
  - Capítulos sem número (`chapter = null`/oneshot não classificável) ou capítulos que possuam apenas link externo (`externalUrl` sem páginas no provedor) recebem status explícito (`UNCLASSIFIED_CHAPTER` ou `EXTERNAL_CHAPTER_ONLY`), não sendo contabilizados como desbloqueio indevido nem quebrando o leitor.

### 5.2. Gatekeeper de Leitura (`canReadChapter`) (`REV-01`, `REV-02`, `REV-08`)
Na chamada `GET /api/leitura/:provider/:chapterId/manifesto` (autenticada via JWT):
1. Valida sessão JWT, `provider` (`mangadex` ou `demo`) e identificador `chapterId`.
2. Consulta metadados do capítulo no provedor correspondente, validando classificação segura (`safe`) e disponibilidade de páginas internas.
3. Aplica a política de acesso segundo o contexto do provedor:
   - **No contexto `demo` (Demonstração Comercial / Paywall):**
     - Calcula a `canonicalPosition` global do capítulo na obra/idioma.
     - Se `canonicalPosition <= 3`: leitura permitida para qualquer usuário autenticado (`Free` ou `Pro`).
     - Se `canonicalPosition > 3` (ou sem posição determinável): consulta `assinaturas` no MariaDB (`status = 'active' AND acesso_ate > UTC_TIMESTAMP()`). Se não for Pro ativo, registra `leitura.bloqueada` no `log-service` e retorna **`403 Forbidden`** com `{ code: 'PLAN_REQUIRED', message: 'Este capítulo faz parte do plano Leitor Pro.', chapterId, canonicalPosition }` — **sem incluir `baseUrl`, `hash`, nomes de arquivos ou URLs de páginas em nenhum campo da resposta ou log**.
   - **No contexto `mangadex` (Integração Real de Leitura):**
     - Verifica sessão autenticada, classificação segura e disponibilidade técnica na API oficial `/at-home/server/:chapterId`, registrando `leitura.liberada` e entregando as URLs das páginas reais sem cobrar paywall comercial sobre a API pública do MangaDex.

### 5.3. CRUD de Estantes Pessoais e Upload Privado com Compensação (`REV-07`, `REV-09`)
- **Isolamento por Dono (inclusive em tabelas filhas):**
  - `GET/PATCH/DELETE /api/estantes/:id` filtram diretamente por `WHERE id = ? AND usuario_id = ?`. Se não encontrar, retorna `404 Not Found` (e registra tentativa negada quando aplicável).
  - `POST/PATCH/DELETE /api/estantes/:id/itens*` e `POST/GET/DELETE /api/estantes/:id/capa` executam primeiro `SELECT id FROM estantes WHERE id = ? AND usuario_id = ?` (com `FOR UPDATE` nas escritas de capa). Se a estante pertencer a outro usuário, retorna **`404 Not Found` antes** de gravar no banco ou enviar bytes ao MinIO.
- **Validação Completa e Compensação de Capas no MinIO (`REV-09`):**
  1. **Autorização Prévia e Limite:** Verifica posse da estante antes do upload; rejeita payloads acima de **5 MiB** com `413 Payload Too Large`.
  2. **Validação Binária e Estrutural de Imagem:** Verifica magic bytes e decodifica os cabeçalhos reais do arquivo (`PNG`, `JPEG`, `WebP`) para extrair `largura_px` e `altura_px`. Rejeita qualquer arquivo que não seja uma imagem íntegra, que tenha dimensões inválidas (`<= 0` ou `> 4096 px` em qualquer eixo / `> 16 MP`), ou que seja SVG/HTML/MIME forjado com `415 Unsupported Media Type`.
  3. **Fluxo Transacional e Compensação (`minio_objetos_pendentes_remocao`):**
     - Gera `object_key` aleatória (`capas/<uuid>.<ext>`).
     - Envia o buffer validado para o bucket privado `mangacloud-capas`.
     - Abre transação no MariaDB com lock na estante (`SELECT id FROM estantes WHERE id = ? AND usuario_id = ? FOR UPDATE`):
       - Se já havia capa anterior em `estante_capas`, registra a `object_key` antiga em `minio_objetos_pendentes_remocao` (`motivo = 'capa_substituida'`) na mesma transação antes de atualizar `estante_capas` com a nova chave.
       - Se a transação SQL falhar após o upload no MinIO: apaga imediatamente a nova `object_key` do MinIO (e, se o MinIO falhar nessa limpeza, grava em `minio_objetos_pendentes_remocao` com `motivo = 'rollback_upload'`), mantendo a capa anterior intacta no banco.
     - Na exclusão de capa (`DELETE /api/estantes/:id/capa`) ou exclusão da estante (`DELETE /api/estantes/:id`), a `object_key` existente em `estante_capas` é copiada para `minio_objetos_pendentes_remocao` **dentro da transação SQL antes do `DELETE`**, evitando que o `ON DELETE CASCADE` apague a referência caso o MinIO falhe no instante da remoção. Após o `COMMIT`, a rotina remove o objeto do MinIO e limpa o registro em `minio_objetos_pendentes_remocao`.

### 5.4. Atualização Atômica de Progresso por Revisão (`REV-05`)
- `PUT /api/progresso/:provider/:mangaId` (Exige assinatura Pro ativa em `assinaturas`; retorna `403 PLAN_REQUIRED` para Free):
  1. Valida `provider` (`mangadex` ou `demo`), consulta no provedor se `chapterId` pertence de fato a `mangaId` no `idioma` informado, se o capítulo é permitido para o usuário e obtém do servidor o `total_paginas` real do capítulo (rejeitando `pagina < 1` ou `pagina > total_paginas_real` com `400 Bad Request`).
  2. Recebe `revisaoEsperada` no body (inteiro `>= 0`):
     - Se `revisaoEsperada === 0` (primeiro registro da obra/idioma): executa `INSERT INTO progresso_leitura (..., revisao) VALUES (..., 1)`. Se ocorrer colisão concorrente (`ER_DUP_ENTRY`), retorna `409 Conflict` com o estado e a revisão atuais.
     - Se `revisaoEsperada >= 1`: executa comparação e incremento **atômico** em uma única instrução SQL:
       ```sql
       UPDATE progresso_leitura
          SET chapter_id = ?, pagina = ?, total_paginas = ?, revisao = revisao + 1, atualizado_em = CURRENT_TIMESTAMP
        WHERE usuario_id = ? AND provider = ? AND manga_id = ? AND idioma = ? AND revisao = ?
       ```
     - Se `affectedRows === 0`, significa que outra aba/requisição já avançou a revisão (ou o registro não existe): o backend consulta a linha atual e retorna **`409 Conflict`** com `{ code: 'STALE_REVISION', currentRevision, currentProgress }`, impedindo sobrescrita silenciosa.
     - Voltar intencionalmente para páginas ou capítulos anteriores é permitido desde que a `revisaoEsperada` enviada seja igual à `revisao` vigente no banco.

### 5.5. Ciclo de Assinatura Stripe e Webhook Idempotente (`REV-06`)
1. **Criação de Sessão (`POST /api/stripe/checkout`):**
   - Extrai `usuario_id` exclusivamente do JWT.
   - Verifica em `assinaturas` se o usuário já possui assinatura `active` com `acesso_ate > UTC_TIMESTAMP()` (retornando `409 ALREADY_SUBSCRIBED` para evitar cobrança duplicada por clique duplo).
   - Reaproveita `stripe_customer_id` vinculado ao próprio usuário (nunca aceitando `customer_id` vindo do cliente) e cria sessão em `mode: 'subscription'` com `STRIPE_PRICE_ID` configurado no servidor.
   - Redirecionamento para `/sucesso` no frontend **não** libera o plano Pro; a tela `/sucesso` consulta `GET /api/assinatura` e exibe estado `"Confirmando pagamento..."` até que o webhook processe o evento.
2. **Processamento Transacional de Webhook (`POST /api/stripe/webhook`):**
   - Recebe raw body (`express.raw`) e valida assinatura criptográfica com `STRIPE_WEBHOOK_SECRET` (retornando `400` se inválida).
   - Abre transação no MariaDB:
     - Consulta `SELECT event_id, status FROM stripe_eventos WHERE event_id = ? FOR UPDATE`.
     - Se já existir com `status = 'processed'`, faz `COMMIT` e retorna `200 OK` (idempotente).
     - Se não existir, insere com `status = 'processing'`; se existir com `status = 'failed'`, atualiza para `status = 'processing'` permitindo reprocessamento.
     - Para eventos de assinatura (`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`):
       - Verifica `ultimo_evento_stripe_ts` na linha de `assinaturas` do usuário. Se o evento recebido tiver timestamp `event.created < ultimo_evento_stripe_ts` (evento atrasado fora de ordem), consulta o estado atual diretamente na API da Stripe (`stripe.subscriptions.retrieve`) antes de aplicar, impedindo que um evento antigo reative uma assinatura já cancelada.
       - Atualiza `assinaturas` (`status`, `acesso_ate`, `cancel_at_period_end`, `ultimo_evento_stripe_ts`) e projeta `usuarios.is_premium` na mesma transação.
       - Marca `stripe_eventos.status = 'processed'` e executa `COMMIT`.
     - Se ocorrer qualquer erro de banco ou de reconciliação durante o processamento: faz `ROLLBACK`, grava `status = 'failed'` em `stripe_eventos` e retorna **`500 Internal Server Error`** para que a Stripe reenvie o webhook (jamais retornando `200` falso).

---

## 6. Auditoria (`log-service`) e Telas do Produto

### 6.1. Eventos de Negócio Obrigatórios
Todos os eventos enviados ao `log-service` contêm `actorId`, `actorRole`, `timestamp` (UTC ISO 8601), `action`, `resourceType`, `resourceId`, `result` (`success` | `denied` | `error`), `reason` e `requestId` (sem senhas, tokens, payloads brutos do Stripe nem URLs de páginas bloqueadas):
- `estante.criada`, `estante.editada`, `estante.excluida`
- `estante.item_adicionado`, `estante.item_removido`
- `estante.capa_enviada`, `estante.capa_removida`
- `favorito.adicionado`, `favorito.removido`
- `leitura.liberada`, `leitura.bloqueada`
- `progresso.atualizado`
- `assinatura.atualizada`
- `usuario.papel_alterado`
- Eventos existentes de autenticação (`auth.login`, `auth.falha`) e bloqueios de autorização (`403`/`404`).

### 6.2. Telas Mínimas no Frontend React
1. **Landing Page Pública (`/`):** Aberta sem login, com proposta de valor do MangaCloud, explicação clara dos planos Free (estantes + 3 primeiros capítulos disponíveis de cada obra) e Pro, e CTA para Criar Conta / Entrar.
2. **Catálogo e Detalhe da Obra (`/catalogo`, `/mangas/:provider/:mangaId`):** Seletor explícito de fonte (`MangaDex Real` vs `Catálogo Demo / Paywall`), busca, filtro por gênero/tag, seletor de idioma (`pt-br`, `en`, etc.), estado claro quando uma obra não possui tradução no idioma selecionado e lista de capítulos indicando posição canônica e status liberado/bloqueado.
3. **Web Reader (`/leitura/:provider/:chapterId`):** Leitura real de capítulos do `mangadex` e leitura demonstrativa do `demo`, navegação por página (botões e teclado), indicador de página e CTA de Paywall caso a API retorne `403 PLAN_REQUIRED`.
4. **Minhas Estantes (`/estantes`, `/estantes/:id`):** Acessível integralmente no plano Free; listar, criar, detalhar, editar nome/descrição, enviar/substituir/remover capa privada (renderizada via `Blob` autenticado, sem `localhost` hardcoded), adicionar/ordenar/remover obras e excluir estante com confirmação.
5. **Painel do Curador (`/curadoria`) e Painel Admin (`/admin`):** Diagnóstico da integração/cobertura para `curador`/`admin`, e gestão de papéis + visualização da trilha de auditoria para `admin`.

---

## 7. Escopo de Limpeza de Legado ("Nada de Tom Hanks / TMDB") (`REV-10`)

Para cumprir o requisito 10 do PDF sem quebrar a infraestrutura existente no Portainer:
- **Onde remover 100% das referências a `"Tom Hanks"`, `"filme"` e `"TMDB"`:**
  - Todo o código-fonte ativo em `frontend/src/**`, `backend/src/**` (rotas, controllers, middlewares, OpenAPI), `auth-service/src/**`, `log-service/src/**`, `index.html`, `.env.example` e variáveis de ambiente de aplicação (`TMDB_API_KEY` removida do `docker-compose.yml` e `.env.example`).
- **Exceções de Infraestrutura Preservadas Deliberadamente (Documentadas):**
  - Nomes de containers, rede (`tom_hanks_net`) e volumes (`redis_data`, `minio_data`) no `docker-compose.yml` caso a stack existente no Portainer dependa deles para manter os volumes e o proxy reverso ativos sem recriação destrutiva.
  - Arquivos históricos de migrações já aplicadas (`001_dominio.sql` / `001_initial_auth_setup.ts`) e documentos acadêmicos da P1 (`P1_Final.typ`, PDFs de enunciado), que fazem parte do histórico exigido pela disciplina.
- **Tabelas Legadas no Banco (`favoritos` de filmes, `comentarios`, tabelas de futebol):**
  - Deixam de ser consultadas por qualquer rota ativa (inclusive `/api/profile`, que passa a retornar o resumo de estantes e favoritos de mangá do usuário). A remoção física (`DROP TABLE`) só será executada após inventário/backup se confirmada como segura sem afetar FKs de `usuarios`.

---

## 8. Ordem de Execução Recomendada em 6 Fases (`REV-10`)

Para eliminar o risco de que detalhes de cobrança bloqueiem os 10 requisitos centrais da Atividade 10, a implementação seguirá exatamente esta ordem:

| Fase | Entregas da Implementadora | Critério para Avançar (Gate QA) |
| :---: | :--- | :--- |
| **Fase 1** | **Inventário, Contrato dos Provedores (`mangadex` + `demo`) e Prova Real de Leitura** | Prova técnica real do MangaDex (`busca -> obra -> capítulos -> manifesto de páginas`) + fixtures `demo` com canonização global testada (`1, 2, 2.5, 3`). |
| **Fase 2** | **Núcleo da Atividade 10: Banco (`migrate`/`seed`), Auth/RBAC (`leitor`/`curador`/`admin`), CRUD de Estantes/Itens, Isolamento e Capas Privadas no MinIO** | Migrations limpas e legadas aprovadas; 3 papéis com revogação imediata; CRUD de estantes/itens com `404` para terceiros; upload privado de capa com validação estrutural e compensação `minio_objetos_pendentes_remocao`. |
| **Fase 3** | **Auditoria (`log-service`), Landing Page Pública, Telas de CRUD/Papéis, Swagger e Limpeza TMDB** | Eventos de negócio visíveis no painel admin; Landing aberta em `/`; telas de estantes/curadoria/admin operacionais; zero referências a Tom Hanks/TMDB no código ativo; builds `tsc` + `vite build` passando sem pular typecheck. |
| **Fase 4** | **Catálogo e Web Reader Integrados (`mangadex` real + `demo` com Gatekeeper Free)** | Leitura real funcionando de ponta a ponta no navegador + bloqueio `403 PLAN_REQUIRED` na 4ª posição canônica do `demo` sem vazar URLs. |
| **Fase 5** | **Pacote de Implantação na Mesma Stack, Healthchecks, Limite de 1 GB e Evidências da Atividade 10** | Imagem Docker com `db/` e builds completos; validação na stack real (mesmo subdomínio, 1 GB RAM/container, sem URLs `localhost`); execução do roteiro de testes do professor e coleta dos 7 prints. |
| **Fase 6** | **Evolução Completa de Assinatura Stripe (Webhook Transacional) e Progresso Atômico por Revisão** | Webhook idempotente atualizando `assinaturas` (`acesso_ate`), `canReadChapter` consultando exclusivamente `assinaturas` (`REV-01`) e `PUT /api/progresso` com comparação atômica de `revisao` (`REV-05`). |

---

## 9. Checklist Final de Entrega Pública ("Seu Negócio no Ar") (`REV-10`)

A Atividade 10 só será declarada concluída quando todos os itens abaixo estiverem comprovados com evidências reais:

- [ ] **1. Repositório e README:** [README.md](../README.md) no repositório público `Paulo794/Manga-Cloud` contendo os blocos do MangaCloud, menção ao professor (`@siriani` / `github.com/siriani`), **URL pública real do sistema no ar** (mesmo subdomínio) e **diagrama de arquitetura atualizado**.
- [ ] **2. Scripts de Banco Versionados:** Arquivos de migration e seed versionados em `db/` e `backend/src/migrations/`, copiados no `Dockerfile` e testados em banco limpo, atualização legada e reexecução idempotente.
- [ ] **3. Builds e Tipagem Limpos:** Compilação TypeScript completa (`tsc --noEmit` / `npm run build`) passando em `frontend`, `backend`, `auth-service` e `log-service`, sem ignorar erros de compilação no `Dockerfile`.
- [ ] **4. Stack no Portainer e Recursos:** Stack existente no Portainer apontando para o commit atual de `Paulo794/Manga-Cloud`, rodando no mesmo subdomínio e mesma porta (`8224:3001`), com **limite efetivo de 1 GB de RAM por container** e todos os containers `healthy`/`running`.
- [ ] **5. Fluxo Público sem `localhost`:** Upload/exibição de avatar, capas de estantes e recuperação de senha funcionando pelo domínio público (sem gerar URLs `http://localhost:...`).
- [ ] **6. Smoke Test do Cenário do Professor (Páginas 4–5 do PDF):**
  - Acesso sem login ao subdomínio exibindo a Landing Page pública com proposta de valor;
  - Duas contas de papéis diferentes (`leitor` e `curador`) + conta `admin` testadas;
  - Criação, edição, listagem e exclusão de estante pessoal com upload de capa no MinIO pela Conta A;
  - Tentativa da Conta B de abrir/editar/excluir o ID da estante ou da capa da Conta A retornando `404` (ou `403`);
  - Chamada direta à API para ação não permitida pelo papel (`leitor` chamando `/api/curadoria/integracao` ou `/api/admin/*`) retornando `403`;
  - Login como `admin` visualizando no log os eventos de negócio com autor e horário;
  - Busca por `"Tom Hanks"`, `"filme"` e `"TMDB"` nas telas e no código ativo retornando vazio.
- [ ] **7. Pacote dos 7 Prints Obrigatórios e Texto da Issue:**
  1. Print da **Landing Page** pública no subdomínio;
  2. Print da **listagem do recurso principal** (Estantes Pessoais / itens);
  3. Print do **`403`** de um papel sem permissão chamado direto na API;
  4. Print do **bloqueio (`404`/`403`) ao tentar abrir o registro de outro usuário**;
  5. Print dos **eventos de negócio no log** (painel Admin);
  6. Print do **arquivo de capa salvo no MinIO**;
  7. Print da **stack no Portainer com os containers saudáveis**.
  - Rascunho completo da issue `Entrega — Seu negócio no ar` (com link do commit implantado, URL pública, os 7 prints e menção a `@siriani`) pronto para publicação mediante autorização do usuário.
