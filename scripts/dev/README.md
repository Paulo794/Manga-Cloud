# Ambiente local

```bash
npm start
```

Execute na raiz do projeto, com Node.js 22+ e Docker/Compose disponíveis. Abre o MangaCloud em `http://localhost:8224`, com banco/storage próprios e dados persistentes. Comandos adicionais: `npm run status`, `npm run check:local`, `npm run logs` e `npm stop`. O executor é Node.js, usa imagens de QA aprovadas e não lê o `.env` principal.

Guia, conta de demonstração e limites das integrações: [execução local](../../docs/EXECUCAO_LOCAL_MANGACLOUD.md).
