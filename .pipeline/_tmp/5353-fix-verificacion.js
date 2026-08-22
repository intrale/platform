// Verificación del fix rev-1 de #5353 (rechazo de seguridad B2).
//
// Reproduce los tres casos del rechazo CONTRA EL CÓDIGO CORREGIDO:
//   1. La raíz de la config la fija el código: PIPELINE_REPO_ROOT / _DIR_OVERRIDE /
//      _STATE_DIR ya no eligen qué config.yaml manda.
//   2. Con `vault.enabled: true` y raíz desviada por entorno, el ancla NO vuelve
//      al régimen de process.env.
//   3. Config ilegible => estado INDETERMINADO (no "vault apagado") y el ancla
//      falla cerrada.
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

// El atacante desvía las TRES env vars de raíz.
const DESVIADA = 'C:\\ruta\\inexistente\\del\\atacante';
process.env.PIPELINE_DIR_OVERRIDE = DESVIADA;
process.env.PIPELINE_STATE_DIR = DESVIADA;
process.env.PIPELINE_REPO_ROOT = DESVIADA;

const cred = require(path.join(ROOT, '.pipeline', 'lib', 'credentials.js'));
const og = require(path.join(ROOT, '.pipeline', 'lib', 'operator-gate.js'));

const driver = {
  kind: 'fake', calls: [],
  getParametersByPathSync() { this.calls.push('p'); return { parameters: [] }; },
  getSecretValueSync() { this.calls.push('s'); return null; },
  async getParametersByPath() { return { parameters: [] }; },
  async getSecretValue() { return null; },
};
const sinArchivos = {
  canonicalPath: path.join(os.tmpdir(), 'no-existe-5353', 'credentials.json'),
  legacyPath: path.join(os.tmpdir(), 'no-existe-5353', 'telegram-config.json'),
};

function correr(titulo, opts) {
  cred._resetVaultCache();
  const env = { TELEGRAM_LEO_OPERATOR_CHAT_ID: '666666666', OPENAI_API_KEY: 'AMBIENTE-OPENAI' };
  const logs = [];
  const r = cred.loadIntoEnv({ ...sinArchivos, env, logger: (m) => logs.push(String(m)), ...opts });
  console.log('\n=== ' + titulo + ' ===');
  console.log('result.vault             =', JSON.stringify(r.vault));
  console.log('ancla en env DESPUES     =', JSON.stringify(env.TELEGRAM_LEO_OPERATOR_CHAT_ID));
  console.log('missing incluye el ancla =', r.missing.includes('TELEGRAM_LEO_OPERATOR_CHAT_ID'));
  console.log('allowlist de firmantes   =', JSON.stringify([...og.resolveOperatorAllowlist(env)]));
  console.log('no-ancla OPENAI_API_KEY  =', JSON.stringify(env.OPENAI_API_KEY), '(', r.sources.OPENAI_API_KEY, ')');
  for (const l of logs) console.log('  | ' + l.slice(0, 130));
}

// --- 1/2: config REAL del checkout, pero con vault.enabled true (copia de prep) ---
const DEST = path.join(os.tmpdir(), 'sec5353fix');
fs.mkdirSync(path.join(DEST, '.pipeline'), { recursive: true });
let yamlSrc = fs.readFileSync(path.join(ROOT, '.pipeline', 'config.yaml'), 'utf8');
const i = yamlSrc.indexOf('\nvault:');
yamlSrc = yamlSrc.slice(0, i) + yamlSrc.slice(i)
  .replace(/\n  enabled: false/, '\n  enabled: true')
  .replace(/\n  hostId: ""/, '\n  hostId: "hostA"');
fs.writeFileSync(path.join(DEST, '.pipeline', 'config.yaml'), yamlSrc);
fs.copyFileSync(path.join(ROOT, 'pipeline.config.json'), path.join(DEST, 'pipeline.config.json'));

correr('CASO A/B · vault.enabled TRUE + raiz desviada por entorno', {
  pipelineDir: path.join(DEST, '.pipeline'), vaultDriver: driver,
});

// --- 3: config ilegible en la raíz que manda ---
const ROTA = fs.mkdtempSync(path.join(os.tmpdir(), 'sec5353-rota-'));
fs.mkdirSync(path.join(ROTA, '.pipeline'));
fs.writeFileSync(path.join(ROTA, '.pipeline', 'config.yaml'), 'no: [es yaml\n  valido: {{{\n');
correr('CASO C · config ILEGIBLE (indeterminado, no "vault apagado")', {
  pipelineDir: path.join(ROTA, '.pipeline'), vaultDriver: driver,
});

// --- 4: camino productivo, sin ningun arg: la raiz la fija el codigo ---
const leido = cred._readVaultConfig({}, () => {});
console.log('\n=== CAMINO PRODUCTIVO (sin args, con las 3 env vars desviadas) ===');
console.log('indeterminado            =', leido.indeterminado);
console.log('vault.enabled leido      =', leido.cfg && leido.cfg.enabled, '(config REAL del checkout)');
