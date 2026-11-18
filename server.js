// Servidor de desenvolvimento do painel FAROL (sem dependências).
//
//   node server.js         abre só neste PC            → http://localhost:8090
//   node server.js --lan   abre também na rede local   → http://<IP do PC>:8091
//                          (use este para testar no navegador da multimídia)
//
// Serve apenas os arquivos da pasta app/, somente leitura.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const lan = process.argv.includes('--lan');
const port = Number(process.env.PORT) || (lan ? 8091 : 8090);
const host = lan ? '0.0.0.0' : '127.0.0.1';
const root = path.join(__dirname, 'app');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');

  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (e) { return send(res, 400, 'Endereço inválido'); }
  if (rel.indexOf('\0') !== -1) return send(res, 400, 'Endereço inválido');
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) return send(res, 403, 'Fora da pasta do painel');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Não encontrado');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error('A porta ' + port + ' já está em uso. Feche o outro servidor ou rode com outra porta (PORT=8095).');
  else console.error(err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log('Painel FAROL no ar.');
  console.log('  Neste PC:        http://localhost:' + port);
  if (!lan) return;
  const nets = os.networkInterfaces();
  let found = false;
  Object.keys(nets).forEach((name) => {
    nets[name].forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) {
        found = true;
        console.log('  Na multimídia:   http://' + n.address + ':' + port + '   (' + name + ')');
      }
    });
  });
  if (!found) console.log('  Nenhuma rede encontrada. Ligue o Wi-Fi do PC e rode de novo.');
  else console.log('A multimídia precisa estar no mesmo Wi-Fi (ou no roteador do celular) que este PC.');
});
