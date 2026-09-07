'use strict';
// QA rev5 #6459 — fixture de sidecars para renderizar el dashboard REAL en sandbox.
const fs = require('fs');
const path = require('path');
const SB = path.join(__dirname, 'sandbox');
const LOGS = path.join(SB, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
for (const f of fs.readdirSync(LOGS)) fs.unlinkSync(path.join(LOGS, f));

const CHAT = '-1001999888';
const rows = [
  [1756130000000, { resultado: 'huerfano', provider: 'anthropic' }],
  [1756129000000, { resultado: 'ok', provider: 'anthropic' }],
  [1756128000000, { resultado: 'error', provider: 'openai' }],
  [1756127000000, { resultado: 'ajustada', provider: 'anthropic' }],
  [1756126000000, { resultado: 'fallback', provider: 'openai' }],
  [1756125000000, null], // sin sidecar ⇒ sin badge (UX-5)
];
for (const [ep, meta] of rows) {
  const base = `commander-${CHAT}-${ep}`;
  fs.writeFileSync(path.join(LOGS, base + '.log'),
    `--- etapa:transcripción ---\nfixture QA rev5 #6459\n`, 'utf8');
  if (meta) fs.writeFileSync(path.join(LOGS, base + '.meta.json'), JSON.stringify(meta), 'utf8');
}
console.log('fixtures:', fs.readdirSync(LOGS).join(' '));
console.log('SANDBOX=' + SB);
