// SMTP em loopback: recebe só fixtures locais, sem encaminhar mensagens.
const net = require('node:net');
const { once } = require('node:events');
module.exports = async function smtpFixture() {
  const messages = [], authentications = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy());
    let buffer = '', inData = false, lines = [], recipient = '';
    socket.write('220 qa.invalid SMTP fixture\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            messages.push({ recipient, data: lines.join('\r\n') });
            inData = false; socket.write('250 Queued locally\r\n');
          } else lines.push(line.replace(/^\.\./, '.'));
        } else if (/^EHLO /i.test(line)) socket.write('250-qa.invalid\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (/^HELO /i.test(line)) socket.write('250 qa.invalid\r\n');
        else if (/^AUTH PLAIN /i.test(line)) { authentications.push(Buffer.from(line.slice(11), 'base64').toString()); socket.write('235 Authenticated locally\r\n'); }
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 Sender OK\r\n');
        else if (/^RCPT TO:/i.test(line)) { recipient = line.slice(8).trim().replace(/^<|>$/g, ''); socket.write('250 Recipient OK\r\n'); }
        else if (line === 'DATA') { inData = true; lines = []; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Goodbye\r\n');
        else if (line === 'RSET' || line === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('502 Unsupported fixture command\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    port: server.address().port, messages, authentications,
    linkFor(email) {
      const message = messages.filter(m => m.recipient === email).at(-1);
      if (!message) throw new Error('Nenhum email local recebido para a fixture.');
      const decoded = message.data.replace(/=\r\n/g, '').replace(/=([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      const link = decoded.match(/https?:\/\/[^\s"<>]+\/reset-password\?token=[a-f0-9]{64}/)?.[0];
      if (!link) throw new Error('Link de recuperação ausente no email local.');
      return link;
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  };
};
