# Operação MangaCloud

## Estado e fronteira da implantação

O código foi preparado para a stack existente. A porta `8224:3001`, os aliases dos serviços e os volumes de Redis/MinIO foram preservados. Não foi criada uma stack pública, não foi alterado o banco principal e não foi enviado nenhum anúncio/issue ao professor.

O `.env` local ainda informa `http://localhost:8224`. O endereço público e as variáveis reais da stack precisam ser conferidos no ambiente de implantação. Não usar esse localhost como URL de recuperação de senha na publicação.

## Configuração

- MariaDB existente: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Segredos estáveis: `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN` e `REDIS_PASSWORD`. Nunca imprimir o arquivo `.env` ou a configuração resolvida com segredos para produzir evidências.
- `APP_URL`: origem pública correta; passa também ao auth-service.
- MinIO: credenciais iguais às da instalação existente. Os defaults do Compose preservam os valores da base anterior para evitar rotação automática, mas devem ser conferidos no ambiente real.
- Buckets novos `mangacloud-capas` e `mangacloud-avatars`: privados; políticas verificadas inclusive quando já existem.
- O adaptador usa `@aws-sdk/client-s3` com endpoint, credenciais MinIO explícitas e path style. O armazenamento continua no mesmo MinIO; não requer conta AWS nem cria buckets na AWS. `MINIO_REGION` deve corresponder à região do servidor (padrão `us-east-1`); conferir antes do redeploy em uma instalação com região personalizada.
- `CATALOG_PROVIDER`: fallback da fábrica de providers. A interface oferece seleção explícita de fonte e abre MangaDex por padrão; URLs e linhas do banco qualificam referências com `demo` ou `mangadex`.
- Stripe: desativado por padrão. Para demonstração, `STRIPE_DEMO_ENABLED=true`, chave `sk_test_`, preço de teste e segredo de webhook. O código recusa chaves live e eventos live. Não há autorização/configuração de cobrança real nesta entrega.
- Cobrança: a migration `004_identidade_cobranca.sql` precisa ser aplicada no alvo revisado antes de usar checkout/gestão. Cria identidade durável por conta; clientes Stripe antigos sem essa identidade exigem reconciliação de propriedade e não são associados automaticamente. Em 12/11 foi aplicada somente em QA.
- QA: pares de email/senha dedicados, opcionais e distintos para os três papéis. Cadastro comum sempre cria leitor. Seed não troca senha/papel de uma conta já existente. Reconhecimento entre processos exige segredo estável para a proveniência HMAC.
- Email: conferir host/porta/credenciais SMTP e `MAIL_FROM` com um remetente válido para o ambiente. Porta 465 usa TLS direto; outras portas negociam STARTTLS quando anunciado. O envio possui timeouts limitados e usa somente a origem `APP_URL` validada no link.

## Antes de atualizar a stack existente

1. Identificar a stack efetiva, seu Compose project, origem `Paulo794/Manga-Cloud`, branch, commit e volumes atuais. Não inferir os nomes dos volumes físicos apenas pelo diretório local.
2. Fazer backup e inventário do banco e dos objetos. Registrar versões/checksums existentes de `schema_migrations` sem alterar o ledger.
3. Construir as imagens e validar os comandos de migration no alvo de QA. Revisar avisos de dependências e configurações antes da publicação.
4. Garantir acesso de manutenção para executar os scripts no container da aplicação, com alvo de banco explicitamente conferido. Não executar testes destrutivos de QA usando as variáveis do banco principal.
5. Atualizar a mesma stack e executar `npm run db:migrate` na imagem com o ambiente de implantação. O script usa JavaScript compilado quando `NODE_ENV=production`; nenhum tsx global é necessário.
6. Executar `npm run db:seed` somente quando desejado. O seed cria dados de demonstração; contas QA só são provisionadas com configuração explícita. Não publicar senhas nos prints.
7. Conferir saúde e limite efetivo de memória nos cinco containers, persistência dos volumes, URL pública, recuperação de senha e carregamento de rotas profundas.
8. Executar o cenário do professor com leitor A, curador B e admin: CRUD/upload, isolamento por ID, 403 de papel e eventos no painel admin. Capturar evidências reais e o commit implantado.

Não usar `down -v`, não recriar banco e não abrir novas portas para resolver um problema de build. Não chamar de deploy concluído uma execução local ou build de imagem.

## Saúde e processos

- Backend: `/health` indica liveness; `/ready` confere o schema de estantes.
- Auth: `/health` confere conexão com MariaDB.
- Logs: `/health` confere Redis pronto.
- MinIO: `/minio/health/ready`; Redis: `redis-cli ping` com autenticação pelo ambiente.
- Remoção compensatória: worker do backend executa a cada 30 segundos, com lote limitado, retentativas/backoff e status de falha. A curadoria vê apenas totais técnicos, sem chaves de objetos privados.
- Se MinIO inicializar depois do app, a inicialização de buckets é repetida pelo worker. Falha de auditoria não deve impedir o CRUD.
- Imagens têm até 5 MiB, até 4096 px por eixo e 16 MP. O servidor decodifica/reencoda e limita uploads simultâneos; metadados e MIME fornecidos pelo cliente não autorizam o arquivo.

## Testes exclusivos de QA

```bash
python3 scripts/qa/run-phase2-mariadb.review.py
python3 scripts/qa/run-phase2-mariadb.review.py --api
python3 scripts/qa/run-phase2-mariadb.review.py --browser
python3 scripts/qa/build-images.review.py
```

O executor usa recursos recém-criados com nomes/labels MangaCloud, senha e portas de loopback aleatórias. Dados de banco/storage de QA ficam em memória ou containers descartáveis; a limpeza se refere somente aos IDs criados. O teste de imagem usa tags novas e containers sem rede, sem trocar imagens da stack existente. Não executar `verifyPhase2Db.ts --integration` avulso contra MariaDB compartilhado: a proteção por host/prefixo não cria uma instância exclusiva por si só.

O navegador usa Chrome local se disponível; caso contrário, requer Chromium instalado pelo Playwright. Evidências locais ficam em `docs/qa/evidencias/`; não são prints do subdomínio ou Portainer público.

O modo padrão usa Stripe simulado com assinatura criptográfica de fixtures e indisponibilidade MangaDex simulada. Isso não constitui transação Stripe externa nem prova de leitura real. Para leitura real usar `npm --prefix backend run verify:phase1 -- --require-live` em rede autorizada e disponível.

O modo explícito `python3 scripts/qa/run-phase2-mariadb.review.py --stripe-live` executa checkout/pagamento/webhook reais em Stripe **teste**, usa banco e usuário QA, inicia seu próprio listener e remove seus objetos remotos ao terminar. Não modifica `.env` ou o banco principal. A ampliação `--stripe-live --stripe-clocks --mangadex-live --public-dns` comprovou o percurso numa conta, fim automático do período e renovação recusada. [Revisão final e limites](QA_REVISAO_FINAL_MANGACLOUD.md). O listener QA não permanece disponível para uso cotidiano.

A recuperação de senha também é exercitada com um servidor SMTP descartável em loopback, sem encaminhar mensagens. O teste recebe o email, confere o link e redefine a senha na interface. Isso valida o código e o protocolo SMTP local; a entrega pelo provedor externo ainda exige conferência no ambiente publicado.

## Rollback

Guardar referência da imagem/commit anterior e backup. Em falha de atualização, retornar a aplicação anterior apenas se compatível com o schema presente. Não remover automaticamente migrations aplicadas, não reescrever checksums e não excluir volumes. Recuperação destrutiva deve ser uma operação separada baseada no backup e no alvo confirmado.

## Pendências externas e evidência acadêmica

- Prova de leitura real MangaDex continua dependente de acesso à API; a fonte não é substituída silenciosamente por Demo.
- Checkout/webhook externos, fim automático do período e falha de renovação com Test Clocks passaram em teste local exclusivo. Uso cotidiano exige configurar explicitamente o ambiente escolhido e o webhook persistente.
- Imagens atualizadas foram construídas e verificadas em 12/11, tags `ffa71f9f9ffc`, sem alterar a stack. Conferir o relatório atual de imagens e o commit antes da publicação.
- A aplicação, README e documentação corrente foram limpos. Identificadores físicos históricos no Compose e eventuais tabelas/variáveis antigas da implantação aguardam inventário com backup, preservando a mesma stack e os volumes.
- Na publicação: URL real e diagrama no README, sete prints exigidos e texto da issue `Entrega — Seu negócio no ar` com commit e `@siriani`. Publicação da mensagem exige instrução explícita; o rascunho não é uma entrega enviada.
- Após atualizações revisadas e remoção da cadeia antiga do cliente MinIO, `npm audit --json` retornou zero alertas nos quatro projetos. Foram repetidos builds, testes de integração/navegador e construção de imagens. Esse resultado não cobre vulnerabilidades do sistema operacional das imagens nem substitui revisão de configuração pública. Detalhes no [relatório de QA](QA_IMPLEMENTACAO_MANGACLOUD.md).
