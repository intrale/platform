// Prueba empírica: ¿el ancla de autorización (B2) se puede des-proteger
// seteando una variable de entorno de RESOLUCIÓN DE CONFIG?
//
// Uso: node 5353-sec-anchor.js <repoRootParaCredentials>
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.PIPELINE_REPO_ROOT = process.argv[2];

const cred = require(path.join(ROOT, '.pipeline', 'lib', 'credentials.js'));
cred._resetVaultCache();

// Driver inyectado: NO hay AWS de por medio. Devuelve el namespace VACÍO, o sea
// "el ancla no está en el vault".
const driver = {
  kind: 'fake',
  getParametersByPathSync() { return { parameters: [] }; },
  getSecretValueSync() { return null; },
  async getParametersByPath() { return { parameters: [] }; },
  async getSecretValue() { return null; },
};

// Ambiente destino: el atacante dejó preseteada el ancla de autorización.
const env = { TELEGRAM_LEO_OPERATOR_CHAT_ID: '666666666' };

const logs = [];
const res = cred.loadIntoEnv({
  env,
  logger: (m) => logs.push(m),
  vaultDriver: driver,
  canonicalPath: path.join(ROOT, '.pipeline', '_tmp', 'no-existe-credentials.json'),
  legacyPath: path.join(ROOT, '.pipeline', '_tmp', 'no-existe-legacy.json'),
});

console.log('PIPELINE_REPO_ROOT       =', process.env.PIPELINE_REPO_ROOT);
console.log('result.vault             =', JSON.stringify(res.vault));
console.log('ancla en env DESPUES     =', JSON.stringify(env.TELEGRAM_LEO_OPERATOR_CHAT_ID));
console.log('source del ancla         =', res.sources.TELEGRAM_LEO_OPERATOR_CHAT_ID);
console.log('missing incluye el ancla =', res.missing.includes('TELEGRAM_LEO_OPERATOR_CHAT_ID'));

const { createGate } = (() => {
  try { return require(path.join(ROOT, '.pipeline', 'lib', 'operator-gate.js')); }
  catch (_) { return {}; }
})();
const og = require(path.join(ROOT, '.pipeline', 'lib', 'operator-gate.js'));
if (typeof og.resolveOperatorAllowlist === 'function') {
  console.log('allowlist de firmantes   =', JSON.stringify([...og.resolveOperatorAllowlist(env)]));
}
console.log('--- logs ---');
for (const l of logs) console.log('  ' + l.slice(0, 160));
