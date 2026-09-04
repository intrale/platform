// Sonda UX #5172 · fase aprobacion · verificacion empirica de CA-UX-1..7
// Usa errores REALES emitidos por el resolver (no fixtures a mano) y el mismo
// wiring de contexto que pulpo.js:1294.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const cs = require(path.join(ROOT, '.pipeline', 'lib', 'config-schema.js'));
const cr = require(path.join(ROOT, '.pipeline', 'lib', 'config-resolver.js'));

const CANARIO = 'UX5172-CANARIO-SUPERSECRETO-abc123';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ux5172-'));
const CODIGOS = ['ENOENT', 'not-a-file', 'empty-or-not-a-map', 'yaml-invalido', 'schema-invalido', 'config-ilegible'];
const violaciones = [];

// Fixtures que producen las 5 causas REALES del resolver.
const fYaml = path.join(TMP, 'yaml-roto.yaml');
fs.writeFileSync(fYaml, `gate:\n  token: ${CANARIO}\n   mal_indentado: x\n`);
const fVacio = path.join(TMP, 'vacio.yaml');
fs.writeFileSync(fVacio, '\n');
const fSchema = path.join(TMP, 'schema-roto.yaml');
fs.writeFileSync(fSchema, `pipelines: "${CANARIO}"\n`);
const fDir = path.join(TMP, 'soy-un-dir.yaml');
fs.mkdirSync(fDir);
const fAusente = path.join(TMP, 'no-existe.yaml');

const CASOS = [
    ['yaml-invalido', fYaml],
    ['empty-or-not-a-map', fVacio],
    ['schema-invalido', fSchema],
    ['not-a-file', fDir],
    ['ENOENT', fAusente],
];

function errorDe(file) {
    try { cr.resolve({ configPath: file }); return null; }
    catch (e) { return e; }
}

console.log('=================== CA-UX-1 / 4 / 5 · las 5 causas reales ===================');
for (const [esperada, file] of CASOS) {
    const err = errorDe(file);
    if (!err) { violaciones.push(`el resolver NO fallo con ${path.basename(file)} (esperaba ${esperada})`); continue; }
    const est = cs.describeConfigFailure(err, { contexto: 'halt-auto', archivo: err.archivo || file, via: err.via });
    const log = cs.formatConfigFailureLog(est, { titulo: 'CONFIG INVÁLIDA — dispatch pausado' });
    const tg = cs.formatConfigFailureTelegram(est, { pausaPreexistente: false });

    console.log(`\n########## fixture=${path.basename(file)} → causa(maquina)=${est.causa} (esperada ${esperada}) ##########`);
    console.log(`LOG (lineas=${log.split('\n').length}) > ${log}`);
    console.log(`TELEGRAM >\n${tg}`);
    console.log(`configErrorState > ${JSON.stringify({ archivo: est.archivo, via: est.via, causa: est.causa, linea: est.linea, columna: est.columna, detalle: est.detalle, accion: est.accion })}`);
    console.log(`>> CANARIO en log=${log.includes(CANARIO)} | en telegram=${tg.includes(CANARIO)} | en detalle=${est.detalle.includes(CANARIO)}`);

    // CA-UX-1 · triada completa en log
    if (!(log.includes(est.archivo) && log.includes(`vía ${est.via}`) && log.includes(est.detalle) && log.includes(est.accion))) {
        violaciones.push(`CA-UX-1: log sin triada completa (${est.causa})`);
    }
    // CA-UX-1 · triada completa en telegram
    if (!(tg.includes(est.archivo) && tg.includes(est.via) && tg.includes(est.detalle) && tg.includes(est.accion))) {
        violaciones.push(`CA-UX-1: telegram sin triada completa (${est.causa})`);
    }
    // CA-UX-1 · log en UNA sola linea (grep-friendly)
    if (log.split('\n').length !== 1) violaciones.push(`CA-UX-1: log multilinea (${est.causa})`);
    // CA-UX-4 · ningun codigo de maquina en superficie de operador
    for (const cod of CODIGOS) {
        for (const [n, t] of [['log', log], ['telegram', tg], ['detalle', est.detalle], ['accion', est.accion]]) {
            if (t.includes(cod)) violaciones.push(`CA-UX-4: codigo de maquina '${cod}' visible en ${n} (${est.causa})`);
        }
    }
    // CA-UX-5 · detalle y accion ya redactados
    if (!est.detalle || !est.accion) violaciones.push(`CA-UX-5: detalle/accion vacio (${est.causa})`);
    if (/undefined|\[object |NaN/.test(est.detalle + est.accion)) violaciones.push(`CA-UX-5: copy con placeholder roto (${est.causa}): ${est.detalle}`);
    // CA-UX-2 · prohibido instruir borrar .paused
    for (const [n, t] of [['log', log], ['telegram', tg]]) {
        if (/borr\w*\s+[^.]{0,30}\.paused/i.test(t)) violaciones.push(`CA-UX-2: instruye borrar .paused en ${n} (${est.causa})`);
    }
    // SEC-1 / CA-14 · nunca el valor crudo
    if (log.includes(CANARIO) || tg.includes(CANARIO)) violaciones.push(`SEC-1: FUGA del canario en ${est.causa}`);
    // regla 6 · sin mayusculas sostenidas alarmistas en el cuerpo
    if (/CORRUPCIÓN|CORRUPCION/.test(tg)) violaciones.push(`regla-6: alarmismo "CORRUPCION" en telegram (${est.causa})`);
}

console.log('\n\n=================== CA-UX-3 · las dos variantes, wiring real de pulpo.js:1294 ===================');
for (const pre of [false, true]) {
    const contexto = pre ? 'halt-preexistente' : 'halt-auto';   // literal de pulpo.js:1294
    const err = errorDe(fYaml);
    const est = cs.describeConfigFailure(err, { contexto, archivo: err.archivo || fYaml, via: err.via });
    const tg = cs.formatConfigFailureTelegram(est, { pausaPreexistente: pre });
    console.log(`\n--- pausaPreexistente=${pre} → variante ${pre ? 'B' : 'A'} ---\n${tg}`);
    const prometeAuto = /(^|[^o] )se levanta sola/.test(tg) && !/no se levanta sola/.test(tg);
    const niegaAuto = /no se levanta sola/.test(tg);
    console.log(`>> promete auto-recovery = ${prometeAuto} | niega auto-recovery = ${niegaAuto}`);
    if (!pre && !prometeAuto) violaciones.push('CA-UX-3: variante A no promete auto-recovery');
    if (pre && !niegaAuto) violaciones.push('CA-UX-3: variante B NO niega el auto-recovery (promesa falsa al operador)');
    if (pre && prometeAuto) violaciones.push('CA-UX-3: variante B promete auto-recovery (copy destructivo)');
}

console.log('\n\n=================== CA-UX-6 · reanudacion ===================');
console.log(cs.formatConfigRecoveryTelegram('.pipeline/config.yaml'));

console.log('\n\n=================== VIOLACIONES ===================');
console.log(violaciones.length ? violaciones.join('\n') : 'NINGUNA');
process.exit(violaciones.length ? 1 : 0);
