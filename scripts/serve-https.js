// 本地 HTTPS 静态服务：手机真机测麦克风必须 HTTPS（iOS/Android 上非 localhost 无法用 getUserMedia）
// 用法: npm run serve:https  → cert/ 不存在时自动用 openssl 生成自签名证书
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8443;
const KEY = path.join(ROOT, 'cert', 'server.key');
const CRT = path.join(ROOT, 'cert', 'server.crt');

const lanIp = Object.values(os.networkInterfaces()).flat()
  .find(i => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';

if (!fs.existsSync(KEY) || !fs.existsSync(CRT)) {
  fs.mkdirSync(path.dirname(KEY), { recursive: true });
  execSync(`openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes ` +
    `-keyout "${KEY}" -out "${CRT}" -subj "/CN=localhost" ` +
    `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${lanIp}"`);
  console.log('已生成自签名证书 cert/server.{key,crt}（局域网 IP 变化后删除 cert/ 重跑即可）');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, (req, res) => {
  let file = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}).listen(PORT, () => {
  console.log('HTTPS 服务已启动（Cache-Control: no-cache）:');
  console.log(`  本机:   https://localhost:${PORT}`);
  console.log(`  局域网: https://${lanIp}:${PORT}  ← 手机访问这个（与电脑同一 Wi-Fi，首次打开点「继续访问」信任证书）`);
});
