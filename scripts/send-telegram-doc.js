const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, '.claude', 'hooks', 'telegram-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = config.bot_token;
const chatId = config.chat_id;

const filePath = process.argv[2];
const caption = process.argv[3] || 'Documento';

if (!filePath || !fs.existsSync(filePath)) {
  console.log('Uso: node send-telegram-doc.js <archivo> [caption]');
  process.exit(1);
}

const unixPath = filePath.replace(/\\/g, '/');
try {
  const cmd = 'curl -s -X POST "https://api.telegram.org/bot' + token + '/sendDocument" -F "chat_id=' + chatId + '" -F "document=@' + unixPath + '" -F "caption=' + caption + '"';
  const result = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
  const parsed = JSON.parse(result);
  console.log(parsed.ok ? 'Enviado OK' : 'Error: ' + JSON.stringify(parsed));
} catch(e) {
  console.log('Error: ' + e.message);
}
