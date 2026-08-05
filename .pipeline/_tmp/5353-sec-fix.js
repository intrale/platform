// ¿Anclar la raíz de config (como ya hace pulpo.js) neutraliza el vector?
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
process.env.PIPELINE_REPO_ROOT = 'C:\\ruta\\inexistente\\del\\atacante';
const cr = require(path.join(ROOT, '.pipeline', 'lib', 'config-resolver.js'));

try {
  const cfg = cr.resolve({});
  console.log('resolve({})                       -> OK  vault.enabled=' + cfg.vault.enabled);
} catch (e) {
  console.log('resolve({})                       -> THROW ' + e.name);
}
try {
  const cfg = cr.resolve({ pipelineDir: path.join(ROOT, '.pipeline') });
  console.log('resolve({pipelineDir: <checkout>}) -> OK  vault.enabled=' + cfg.vault.enabled);
} catch (e) {
  console.log('resolve({pipelineDir: <checkout>}) -> THROW ' + e.name);
}
