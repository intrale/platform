const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.claude', 'hooks', 'telegram-config.json'), 'utf8'));
const filePath = process.argv[2];
const caption = process.argv[3] || 'Video';

if (!filePath || !fs.existsSync(filePath)) {
  console.log('Uso: node send-telegram-video.js <archivo.mp4> [caption]');
  process.exit(1);
}

const absPath = path.resolve(filePath).replace(/\\/g, '/');
const cmd = [
  'curl', '-s', '-X', 'POST',
  'https://api.telegram.org/bot' + config.bot_token + '/sendVideo',
  '-F', 'chat_id=' + config.chat_id,
  '-F', 'video=@' + absPath,
  '-F', 'caption=' + caption
].join(' ');

try {
  const result = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
  const parsed = JSON.parse(result);
  console.log(parsed.ok ? 'Video enviado OK' : 'Error: ' + parsed.description);
} catch(e) {
  console.log('Error: ' + e.message);
}
