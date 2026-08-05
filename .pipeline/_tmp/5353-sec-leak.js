// Cruce del dry-run del CLI contra los valores reales del store de credenciales.
const { execFileSync } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

let stdout = '', stderr = '';
try {
  stdout = execFileSync(process.execPath, [path.join(ROOT, '.pipeline', 'lib', 'credentials.js')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  stdout = String(e.stdout || ''); stderr = String(e.stderr || '');
}
const salida = stdout + stderr;

const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'credentials.json'), 'utf8'));
const vals = [];
(function walk(o) {
  for (const k of Object.keys(o || {})) {
    const v = o[k];
    if (v && typeof v === 'object') walk(v);
    else if (typeof v === 'string' && v.length >= 10) vals.push(v);
  }
})(store);
const fugas = vals.filter((v) => salida.includes(v));
console.log('valores del store chequeados (len>=10):', vals.length);
console.log('FUGAS en la salida del dry-run       :', fugas.length);
console.log('salida (primeros 400 chars):');
console.log(stdout.replace(/\s+/g, ' ').slice(0, 400));
