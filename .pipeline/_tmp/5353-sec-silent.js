// Variante SILENCIOSA: la raíz apuntada por PIPELINE_REPO_ROOT tiene una config
// válida que declara `vault.enabled: false`. No hay ni un WARN.
const fs = require('fs'), os = require('os'), path = require('path');
const DEST = path.join(os.tmpdir(), 'sec5353b');
const ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(DEST, '.pipeline'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '.pipeline', 'config.yaml'), path.join(DEST, '.pipeline', 'config.yaml'));
fs.copyFileSync(path.join(ROOT, 'pipeline.config.json'), path.join(DEST, 'pipeline.config.json'));
console.log('raiz alternativa preparada (vault.enabled: false, config VALIDA):', DEST);
