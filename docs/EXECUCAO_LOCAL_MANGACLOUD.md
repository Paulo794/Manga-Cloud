# Abrir o MangaCloud no computador

O ambiente local usa `compose.local.yml`, com banco MariaDB, MinIO e Redis próprios. A stack do Portainer e o banco principal permanecem separados deste ambiente. O `.env` existente não é lido pelo executor local.

Da pasta do projeto, com Node.js 22+ e Docker/Compose disponíveis:

```bash
npm start
```

Abra:

- Aplicação: http://localhost:8224
- Catálogo Demo: http://localhost:8224/catalogo?provider=demo
- Swagger: http://localhost:8224/api-docs

Crie sua conta pela interface para testar o uso como leitor. Para conhecer administração, auditoria e curadoria, o seed deste ambiente cria uma **conta demonstrativa exclusivamente local**:

- Email: `admin@mangacloud.local`
- Senha de demonstração: `MangaCloudLocal123!`

O acesso publicado está vinculado somente a `127.0.0.1`. Essa conta e esse Compose são para desenvolvimento no computador; a publicação acadêmica usa a stack existente e sua configuração revisada.

## Iniciar, parar e consultar

```bash
npm run status
npm run check:local
npm run logs
npm stop
npm start
```

`npm stop` para apenas os containers deste ambiente, preservando contas, estantes e uploads nos volumes locais. `npm start` inicia novamente e reaplica migrations/seed idempotentes. O executor Node.js verifica labels de propriedade antes de atuar nos recursos. Os comandos da raiz não exigem instalar pacotes npm adicionais.

Segredos de desenvolvimento são gerados uma vez em `.local/preview.env`, com acesso restrito e fora do Git. Preserve esse arquivo junto aos volumes para manter as credenciais e o reconhecimento das contas do seed entre reinícios. O programa não oferece limpeza destrutiva de volumes.

## O que explorar

1. Landing e catálogo Demo, com três obras sintéticas identificadas.
2. Cadastro/login, estantes, inclusão de obras e favoritos.
3. Upload de capa e avatar, biografia e leitura dos capítulos Free do Demo.
4. Tela de planos, painel admin, alteração de papéis, curadoria e logs.

O catálogo MangaDex também pode ser selecionado pela interface. A rede usada nas validações apresentou limitação de DNS; o QA real passou com resolução temporária explícita, que não é aplicada neste ambiente. Se a fonte real estiver indisponível, selecione Demo para explorar a aplicação.

Checkout Stripe e envio de recuperação por SMTP ficam desabilitados neste ambiente inicial. As telas estão disponíveis, e o ciclo Stripe real de teste já foi validado em QA separado. Habilitar essas integrações no ambiente de uso exige configurar explicitamente chave/preço/webhook e SMTP adequados.

## Imagens locais

O executor usa as imagens aprovadas em `docs/qa/evidencias/build-images.json`, já construídas neste computador. Depois de alterar o código, reconstrua e inicie novamente:

```bash
python3 scripts/qa/build-images.review.py
npm start
```

Em outra máquina, Docker/Compose e as imagens base precisam estar disponíveis antes da construção. O ambiente local usa imagens existentes e não troca a origem da stack pública.

## Frontend e backend durante a edição

O frontend é React/TypeScript com Vite; o backend e os serviços de autenticação e logs usam Node.js/TypeScript. Python é usado nos executores de QA e construção de imagens, não para executar a aplicação.

`npm start` na raiz inicia o ambiente completo em containers, com o frontend já compilado. Esse modo permite explorar a aplicação e não recarrega o código automaticamente. Os comandos individuais de desenvolvimento já existem: `npm --prefix frontend run dev` inicia o Vite, e `npm --prefix backend run dev` inicia a API com recarga automática. Autenticação e logs também têm `npm run dev` nas respectivas pastas.

Executar cada serviço fora dos containers exige instalar suas dependências e configurar as conexões de desenvolvimento. O proxy atual do Vite espera a API em `http://localhost:3001`; o ambiente completo desta página publica a aplicação em `http://localhost:8224`.

O Compose original `docker-compose.yml` permanece reservado à implantação existente, após revisão de ambiente, backup, banco, domínio e Portainer.
