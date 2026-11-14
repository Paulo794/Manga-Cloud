// Opt-in exclusivo dos testes ao vivo. Não é importado pela aplicação.
const dns = require('node:dns');
const { isIP } = require('node:net');

module.exports = function installPublicDns() {
  const original = dns.lookup, cache = new Map(), pending = new Map();
  const allowed = host => host === 'api.mangadex.org' || host === 'uploads.mangadex.org' || host.endsWith('.mangadex.network');
  function publicV4(address) {
    if (isIP(address) !== 4) return false;
    const [a, b] = address.split('.').map(Number);
    return ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
  }
  async function resolve(host) {
    if (!allowed(host)) throw new Error('Domínio fora da lista MangaDex do teste.');
    if (cache.get(host)?.expiresAt > Date.now()) return cache.get(host).addresses;
    if (pending.has(host)) return pending.get(host);
    const promise = (async () => {
      const url = new URL('https://cloudflare-dns.com/dns-query'); url.searchParams.set('name', host); url.searchParams.set('type', 'A');
      const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Resolvedor temporário indisponível.');
      const body = await response.json();
      const answers = (body.Answer || []).filter(item => item.type === 1 && publicV4(item.data));
      if (body.Status !== 0 || !answers.length) throw new Error('Nenhum endereço público recebido para o teste.');
      const addresses = answers.map(item => ({ address: item.data, family: 4 }));
      cache.set(host, { addresses, expiresAt: Date.now() + Math.min(300, ...answers.map(item => Math.max(1, Number(item.TTL) || 30))) * 1000 });
      return addresses;
    })();
    pending.set(host, promise);
    try { return await promise; } finally { pending.delete(host); }
  }
  dns.lookup = function (host, options, callback) {
    if (typeof host !== 'string' || !allowed(host)) return original.apply(this, arguments);
    if (typeof options === 'function') { callback = options; options = {}; }
    const settings = typeof options === 'number' ? { family: options } : options || {};
    resolve(host).then(addresses => {
      if (settings.family === 6) callback(Object.assign(new Error('Teste temporário usa IPv4.'), { code: 'ENODATA' }));
      else if (settings.all) callback(null, addresses);
      else callback(null, addresses[0].address, 4);
    }, error => callback(error));
  };
  return {
    resolve,
    mappings: () => Object.fromEntries([...cache].map(([host, entry]) => [host, entry.addresses.map(item => item.address)])),
    restore: () => { dns.lookup = original; }
  };
};
