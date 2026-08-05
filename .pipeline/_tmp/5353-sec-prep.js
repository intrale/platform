// Preparación de escenario para la auditoría de seguridad de #5353.
// Copia la config del checkout a un directorio temporal y enciende `vault.enabled`.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const DEST = path.join(os.tmpdir(), 'sec5353');
fs.mkdirSync(path.join(DEST, '.pipeline'), { recursive: true });

let yamlSrc = fs.readFileSync(path.join(ROOT, '.pipeline', 'config.yaml'), 'utf8');
const antes = yamlSrc;
// Encender SOLO la clave `enabled` de la sección `vault:`.
const i = yamlSrc.indexOf('\nvault:');
if (i < 0) throw new Error('no se encontró la sección vault:');
const cabeza = yamlSrc.slice(0, i);
let cola = yamlSrc.slice(i);
cola = cola.replace(/\n  enabled: false/, '\n  enabled: true');
cola = cola.replace(/\n  hostId: ""/, '\n  hostId: "hostA"');
yamlSrc = cabeza + cola;
if (yamlSrc === antes) throw new Error('no se pudo encender vault.enabled');

fs.writeFileSync(path.join(DEST, '.pipeline', 'config.yaml'), yamlSrc);
fs.copyFileSync(path.join(ROOT, 'pipeline.config.json'), path.join(DEST, 'pipeline.config.json'));
console.log('DEST=' + DEST);
console.log(yamlSrc.slice(yamlSrc.indexOf('\nvault:'), yamlSrc.indexOf('\nvault:') + 260));
