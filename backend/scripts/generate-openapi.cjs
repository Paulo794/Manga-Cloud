const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yamljs');
const object = properties => ({ type: 'object', properties });
const string = { type: 'string' }, integer = { type: 'integer' };
const reference = { type: 'string', enum: ['demo', 'mangadex'] };
const doc = { openapi: '3.0.3', info: { title: 'MangaCloud API', version: '2.0.0', description: 'Estantes privadas, catálogo e leitura. MangaDex real não possui paywall comercial; assinatura de teste aplica-se ao Demo. Papel e plano são independentes.' }, servers: [{ url: '/api' }], security: [{ BearerAuth: [] }], components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: {
  Error: object({ code: string, message: string, requestId: string }),
  Shelf: object({ id: integer, nome: { type: 'string', maxLength: 100 }, descricao: { type: 'string', maxLength: 1000, nullable: true }, totalItens: integer, possuiCapa: { type: 'boolean' } }),
  Subscription: object({ plano: { type: 'string', enum: ['free', 'pro'] }, isPro: { type: 'boolean' }, status: string, acessoAte: { type: 'string', format: 'date-time', nullable: true }, cancelAtPeriodEnd: { type: 'boolean' }, canManageRenewal: { type: 'boolean' } }),
  Manifest: object({ provider: reference, chapterId: string, mangaId: string, title: string, language: string, totalPages: integer, pages: { type: 'array', items: object({ pageNumber: integer, imageUrl: string }) } })
} }, paths: {} };
function route(url, method, summary, options = {}) {
  const parameters = [...url.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: match[1] === 'provider' ? reference : string }));
  const responses = { [options.status || '200']: { description: options.status === '204' ? 'Removido.' : 'Operação concluída.', ...(options.status === '204' ? {} : { content: { 'application/json': { schema: options.response || { type: 'object', additionalProperties: true } } } }) } };
  for (const code of [400, 401, 403, 404, 409, 413, 415, 422, 429, 503, 504]) responses[code] = { description: 'Erro validado. 403 pode indicar PLAN_REQUIRED; respostas negadas nunca contêm páginas.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const operation = { summary, parameters: [...parameters, ...(options.query || []).map(([name, schema]) => ({ name, in: 'query', schema }))], responses };
  if (options.public) operation.security = [];
  if (options.optional) operation.security = [{}, { BearerAuth: [] }];
  if (options.body) operation.requestBody = { required: true, content: { [options.multipart ? 'multipart/form-data' : 'application/json']: { schema: options.body } } };
  if (options.headers) operation.parameters.push(...options.headers);
  (doc.paths[url] ||= {})[method] = operation;
}
const paged = [['page', { type: 'integer', minimum: 1 }], ['limit', { type: 'integer', minimum: 1, maximum: 100 }]];
route('/auth/register', 'post', 'Criar conta sempre como leitor', { public: true, status: '201', body: { ...object({ nome: string, email: { type: 'string', format: 'email' }, senha: { type: 'string', minLength: 6, maxLength: 72 } }), required: ['nome', 'email', 'senha'] } });
route('/auth/login', 'post', 'Entrar e obter JWT', { public: true, body: { ...object({ email: string, senha: string }), required: ['email', 'senha'] } });
route('/auth/verify', 'get', 'Verificar sessão e papel atual');
route('/auth/logout', 'post', 'Registrar saída no navegador');
route('/auth/forgot-password', 'post', 'Solicitar recuperação de senha', { public: true, body: object({ email: string }) });
route('/auth/reset-password', 'post', 'Consumir token de recuperação uma única vez', { public: true, body: object({ token: string, novaSenha: string }) });
route('/estantes', 'get', 'Listar somente as próprias estantes', { query: paged });
route('/estantes', 'post', 'Criar estante privada', { status: '201', body: { ...object({ nome: { type: 'string', minLength: 1, maxLength: 100 }, descricao: { type: 'string', maxLength: 1000 } }), required: ['nome'] } });
route('/estantes/{id}', 'get', 'Detalhar estante própria e itens hidratados em lote', { query: paged });
route('/estantes/{id}', 'patch', 'Editar nome/descrição da própria estante', { body: object({ nome: string, descricao: { ...string, nullable: true } }) });
route('/estantes/{id}', 'delete', 'Excluir estante e agendar remoção de capa', { status: '204' });
route('/estantes/{id}/itens', 'post', 'Associar uma obra validada do provedor', { status: '201', body: object({ provider: reference, mangaId: string }) });
route('/estantes/{id}/itens/{itemId}', 'patch', 'Ordenar item próprio', { body: object({ ordem: { type: 'integer', minimum: 0, maximum: 1000000 } }) });
route('/estantes/{id}/itens/{itemId}', 'delete', 'Remover item próprio', { status: '204' });
route('/estantes/{id}/capa', 'post', 'Enviar/substituir capa JPEG/PNG/WebP até 5 MiB; reencodada no servidor', { status: '201', multipart: true, body: { ...object({ capa: { type: 'string', format: 'binary' } }), required: ['capa'] } });
route('/estantes/{id}/capa', 'get', 'Obter imagem privada autenticada');
doc.paths['/estantes/{id}/capa'].get.responses[200].content = { 'image/webp': { schema: { type: 'string', format: 'binary' } } };
route('/estantes/{id}/capa', 'delete', 'Remover capa própria', { status: '204' });
route('/favoritos', 'get', 'Listar favoritos próprios', { query: paged });
route('/favoritos', 'post', 'Favoritar referência externa', { status: '201', body: object({ provider: reference, mangaId: string }) });
route('/favoritos/{provider}/{mangaId}', 'delete', 'Remover favorito próprio', { status: '204' });
route('/mangas/config', 'get', 'Provedor padrão configurado no servidor', { public: true, response: object({ defaultProvider: reference }) });
route('/mangas', 'get', 'Buscar obras na fonte selecionada, sem fallback silencioso', { optional: true, query: [...paged, ['provider', reference], ['q', string], ['tag', string], ['idioma', string]] });
route('/mangas/tags', 'get', 'Consultar tags da fonte', { public: true, query: [['provider', reference]] });
route('/mangas/{provider}/{mangaId}', 'get', 'Detalhar obra permitida', { public: true });
route('/mangas/mangadex/{mangaId}/capa', 'get', 'Capa de obra safe via servidor; cache em memória, sem URL arbitrária ou persistência', { public: true });
doc.paths['/mangas/mangadex/{mangaId}/capa'].get.responses[200].content = Object.fromEntries(['image/jpeg', 'image/png', 'image/webp'].map(mime => [mime, { schema: { type: 'string', format: 'binary' } }]));
route('/mangas/{provider}/{mangaId}/capitulos', 'get', 'Capítulos e elegibilidade; nunca inclui manifesto', { optional: true, query: [['idioma', string]] });
route('/leitura/{provider}/{chapterId}/manifesto', 'get', 'Autorizar no servidor e retornar páginas', { response: { $ref: '#/components/schemas/Manifest' } });
route('/assinatura', 'get', 'Consultar assinatura vigente; não usa booleano legado', { response: { $ref: '#/components/schemas/Subscription' } });
route('/progresso', 'get', 'Histórico próprio preservado mesmo após expiração', { query: paged });
route('/progresso/{provider}/{mangaId}', 'get', 'Consultar revisão/progresso próprio da obra', { query: [['idioma', string]] });
route('/progresso/{provider}/{mangaId}', 'put', 'Pro: salvar progresso com comparação atômica de revisão', { body: { ...object({ chapterId: string, idioma: string, pagina: { type: 'integer', minimum: 1 }, revisaoEsperada: { type: 'integer', minimum: 0 } }), required: ['chapterId', 'idioma', 'pagina', 'revisaoEsperada'] } });
route('/profile', 'get', 'Perfil próprio sem hash ou dados alheios');
route('/profile', 'put', 'Editar biografia própria', { body: object({ bio: { type: 'string', maxLength: 1000 } }) });
route('/profile/avatar', 'get', 'Obter avatar privado autenticado');
doc.paths['/profile/avatar'].get.responses[200].content = { 'image/webp': { schema: { type: 'string', format: 'binary' } } };
route('/profile/avatar', 'post', 'Enviar avatar até 5 MiB', { status: '201', multipart: true, body: object({ file: { type: 'string', format: 'binary' } }) });
route('/curadoria/integracao', 'get', 'Curador/admin: disponibilidade técnica e totais de limpeza, sem bibliotecas alheias');
route('/admin/usuarios', 'get', 'Admin: usuários sem dados privados de biblioteca ou hashes', { query: paged });
route('/admin/usuarios/{id}/papel', 'patch', 'Admin: mudar papel com revalidação no auth-service', { body: object({ papel: { type: 'string', enum: ['leitor', 'curador', 'admin'] } }) });
route('/admin/logs', 'get', 'Admin: trilha de auditoria do log-service');
route('/stripe/checkout', 'post', 'Criar/reutilizar checkout de teste; preço e cliente definidos pelo servidor', { body: object({}) });
route('/stripe/cancelar', 'post', 'Cancelar renovação da própria assinatura ao fim do período pago; preserva dados', { body: object({}), response: { $ref: '#/components/schemas/Subscription' } });
route('/stripe/reativar', 'post', 'Manter renovação da própria assinatura ainda ativa, antes do cancelamento efetivo', { body: object({}), response: { $ref: '#/components/schemas/Subscription' } });
route('/stripe/webhook', 'post', 'Webhook Stripe de teste, raw body e assinatura obrigatória', { public: true, body: object({}), headers: [{ in: 'header', name: 'stripe-signature', required: true, schema: string }] });
const base = path.resolve(__dirname, '..');
fs.writeFileSync(path.join(base, 'src/docs/openapi.yaml'), YAML.stringify(doc, 12, 2));
const authDoc = JSON.parse(JSON.stringify(doc));
authDoc.info.title = 'MangaCloud Auth API'; authDoc.servers = [{ url: '/auth' }]; authDoc.paths = {};
for (const [url, operations] of Object.entries(doc.paths)) {
  if (url.startsWith('/auth/') && url !== '/auth/logout') authDoc.paths[url.slice(5)] = operations;
  if (url.startsWith('/admin/usuarios')) authDoc.paths[url] = operations;
}
fs.writeFileSync(path.resolve(base, '../auth-service/src/docs/openapi.yaml'), YAML.stringify(authDoc, 12, 2));
console.log('Contratos MangaCloud e auth-service gerados.');
