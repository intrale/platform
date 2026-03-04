const fs = require('fs');
const https = require('https');
const path = require('path');

const configPath = path.join(__dirname, '..', '.claude', 'hooks', 'telegram-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const pdfPath = process.argv[2];
if (!pdfPath) { console.error('Uso: node send-report-telegram.js <path-al-pdf>'); process.exit(1); }

const pdfData = fs.readFileSync(pdfPath);
const filename = path.basename(pdfPath);
const boundary = 'boundary' + Date.now();
const caption = process.argv[3] || 'Reporte de sprint';

let body = '';
body += '--' + boundary + '\r\n';
body += 'Content-Disposition: form-data; name="chat_id"\r\n\r\n' + config.chat_id + '\r\n';
body += '--' + boundary + '\r\n';
body += 'Content-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n';
body += '--' + boundary + '\r\n';
body += 'Content-Disposition: form-data; name="document"; filename="' + filename + '"\r\nContent-Type: application/pdf\r\n\r\n';
const tail = '\r\n--' + boundary + '--\r\n';
const bodyBuf = Buffer.concat([Buffer.from(body), pdfData, Buffer.from(tail)]);

const options = {
  hostname: 'api.telegram.org',
  path: '/bot' + config.bot_token + '/sendDocument',
  method: 'POST',
  headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': bodyBuf.length }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    const r = JSON.parse(data);
    console.log(r.ok ? 'Enviado OK a Telegram' : 'Error: ' + data);
  });
});
req.write(bodyBuf);
req.end();
