# Executores de QA do MangaCloud

Os scripts Python coordenam containers Docker exclusivos de teste. Os scripts JavaScript verificam integrações externas. O código da aplicação permanece em `frontend`, `backend`, `auth-service` e `log-service`.

```bash
python3 scripts/qa/run-phase2-mariadb.review.py --browser
python3 scripts/qa/build-images.review.py
node scripts/qa/check-external-services.cjs
node scripts/qa/verify-mangadex-live.cjs
```

O teste HTTP normal simula Stripe e a indisponibilidade MangaDex. Para testar a fonte real separadamente:

```bash
python3 scripts/qa/run-phase2-mariadb.review.py --mangadex-live
```

A opção adicional `--public-dns` usa resolução pública temporária somente no processo e no navegador de QA. O modo padrão continua usando o DNS do sistema, e não há fallback automático. Nenhum desses executores altera o DNS da máquina, grava IP fixo no adaptador ou desabilita a validação HTTPS.

Para o ciclo Stripe externo em **modo de teste**, com conta e serviços descartáveis:

```bash
python3 scripts/qa/run-phase2-mariadb.review.py --stripe-live
```

Requer Chrome/Playwright, `backend/stripe` e chave/preço de teste no `.env`. Lê somente esses dois valores, habilita Stripe apenas no processo e captura o secret do listener em memória. Cria checkout pela aplicação, paga com cartão de teste, confere webhook/Pro/retomada, agenda/restaura renovação e encerra a assinatura QA na limpeza. Remove somente clientes remotos com email aleatório e identidade desta execução; não altera o `.env` nem o banco principal. Resultado em `docs/qa/evidencias/stripe-live.json`. Não é uma consulta somente leitura nem uma prova de fim automático após avançar um mês; detalhes em [QA da assinatura](../../docs/QA_ASSINATURA_MANGACLOUD.md).

Prova ampliada numa única conta, com MangaDex real e Test Clocks:

```bash
python3 scripts/qa/run-phase2-mariadb.review.py --stripe-live --stripe-clocks --mangadex-live --public-dns
```

`--stripe-clocks` exige `--stripe-live`. Após checkout/pagamento, anexa um relógio ao cliente QA e comprova fim automático do período; prepara uma segunda assinatura pela API para simular renovação recusada. O listener é parado depois das verificações e antes da exclusão dos objetos; cliente, assinaturas e relógio QA são removidos. Com MangaDex habilitado, usa a mesma conta para leitura real Free e retomada Pro. [Revisão final](../../docs/QA_REVISAO_FINAL_MANGACLOUD.md).

O build de imagens grava início, sucesso ou falha em `build-images.json`, com tags em `images`. As tags atuais aprovadas são `ffa71f9f9ffc`. A construção não atualiza a stack existente.

`check-external-services.cjs` consulta somente o preço Stripe já configurado e verifica conexão/autenticação SMTP. Não cria checkout, não realiza cobrança e não envia email. Os relatórios são sanitizados para omitir segredos.

Os testes ficam em `tests/qa/` e as evidências em `docs/qa/evidencias/`. Imagens construídas recebem tags novas; nenhuma stack existente é atualizada por esses comandos.
