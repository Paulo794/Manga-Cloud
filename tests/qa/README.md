# Testes do MangaCloud

Arquivos `.cjs` são JavaScript CommonJS executado pelo Node.js. Eles verificam o código TypeScript da aplicação sem mudar sua linguagem ou sua estrutura de serviços.

- `phase1-providers.review.cjs`: regressões de provedores/canonização, sem rede.
- `phase2-seed.review.cjs`: regressões de segurança e idempotência do seed.
- `mangadex-covers.review.cjs`: proxy de capas, metadados/destino, limites, cache e erros, sem rede.
- `phase2-api.integration.cjs`: API com MariaDB, MinIO e Redis reais e exclusivos de QA.
- `browser.integration.cjs`: fluxo desktop/mobile com catálogo Demo, retomada Pro, cancelamento/reativação, perfil, administração e recuperação; Stripe simulado.
- `reader-review.integration.cjs`: saída rápida, retry de imagem, save pendente na troca de capítulo, conflito entre abas, teclado e substituição do documento; API/banco reais exclusivos de QA.
- `pagination-review.integration.cjs`: navegação por listas com 101 registros, seleção de destino além de 100, itens e troca entre favoritos/histórico; dados exclusivos do QA.
- `stripe-live.integration.cjs`: opt-in de checkout hospedado, pagamento com cartão de teste, webhook real por CLI, Pro/retomada, gestão e retorno a Free; suporta Test Clocks e percurso em uma conta com MangaDex; remove os próprios objetos Stripe QA.
- `smtp.fixture.cjs`: SMTP local, sem encaminhamento de mensagens.
- `mangadex-browser.integration.cjs`: capas em catálogo desktop/mobile, obra e estante e leitura real MangaDex no Chrome, com conta Free. Registra sucesso e falha no relatório da rodada.
- `public-dns.fixture.cjs`: resolução temporária de domínios MangaDex, importada somente pelo modo explícito de teste ao vivo. Não é usada na aplicação.

Execução da raiz:

```bash
node tests/qa/phase1-providers.review.cjs
node tests/qa/phase2-seed.review.cjs
node tests/qa/mangadex-covers.review.cjs
python3 scripts/qa/run-phase2-mariadb.review.py --browser
```

Para integração real, usar o executor em `scripts/qa/`; ele cria e remove os seus próprios containers. Não executar a suíte de banco diretamente contra a instalação principal. Relatórios e evidências ficam em `docs/qa/`.
