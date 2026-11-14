# Ambiente local

```bash
npm start
```

Execute na raiz do projeto, com Node.js 22+ e Docker/Compose disponíveis. Constrói automaticamente as imagens locais na primeira execução a partir de um clone limpo (sem depender de `.env` nem de relatórios prévios de QA) e abre o MangaCloud em `http://localhost:8224`, com banco e storage próprios.

Comandos adicionais: `npm run build:local` (ou `npm start -- --build` para reconstruir após alterações no código), `npm run status`, `npm run check:local`, `npm run logs` e `npm stop`.

Guia, conta de demonstração e limites das integrações: [execução local](../../docs/EXECUCAO_LOCAL_MANGACLOUD.md).
