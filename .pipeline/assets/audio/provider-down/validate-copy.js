#!/usr/bin/env node
/**
 * UX #6144 — valida el copy canónico contra los CA de forma (CA-3, CA-4, CA-5,
 * CA-6, CA-7, CA-11, CA-21). Es el chequeo que UX corre sobre `copy.json`;
 * los tests del dev (CA-20..CA-24) validan además la lógica de construcción.
 */
const path = require('path');
const COPY = require(path.join(__dirname, 'copy.json'));

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const MARKDOWN = /[*_`#[\]]/;
const HORA = /\d{1,2}:\d{2}/;
const RUTA = /[\\]|\/\/|\.(js|json|ogg|mp3|yaml)\b/;
const CMD_ALLOWLIST = /\/(status|listado|lanzar)\b/g;

let errors = 0;
const fail = (msg) => { console.log('  FALLA: ' + msg); errors++; };

console.log('=== TEXTO TELEGRAM ===');
const t = COPY.texto;
for (const [causa, v] of Object.entries(t.causas)) {
    const rec = causa === 'reposo' ? v.recuperacion.replace('{HH:MM}', '20:00') : v.recuperacion;
    const full = [v.titular, t.bloque_sigue, t.bloque_pedido, rec].join('\n\n');
    const slashes = (full.match(/\//g) || []).length;
    const allowed = (full.match(CMD_ALLOWLIST) || []).length;
    console.log(`${causa.padEnd(12)} ${String(full.length).padStart(3)} chars`);

    if (full.length > 600) fail(`CA-7: texto ${full.length} > 600`);
    if (RUTA.test(full)) fail('CA-6: contiene ruta/extension de archivo');
    if (slashes !== allowed) fail(`CA-6: ${slashes - allowed} slash fuera de la allowlist de comandos`);
    if (causa === 'reposo' && !HORA.test(full)) fail('CA-3: reposo debe llevar hora exacta');
    if (causa !== 'reposo' && HORA.test(full)) fail(`CA-3: ${causa} no debe llevar hora`);
    if (!/no quedó encolado/.test(full)) fail('CA-4: falta la frase de pedido descartado');
    if (/te aviso|avisar[ée]|te notifico/i.test(full)) fail('CA-5: promete un aviso de recuperación inexistente');
    if (!/pipeline y los agentes siguen trabajando/.test(full)) fail('CA-1(b): falta el bloque de qué sigue vivo');
}

console.log('\n=== GUION DE VOZ (clips pregrabados) ===');
for (const [causa, v] of Object.entries(COPY.voz_clip)) {
    console.log(`${causa.padEnd(12)} ${String(v.length).padStart(3)} chars`);
    if (v.length > 600) fail(`CA-11: guion ${v.length} > 600`);
    if (/\//.test(v)) fail('CA-21: guion contiene slash');
    if (/\\/.test(v)) fail('CA-21: guion contiene backslash');
    if (/\.js/.test(v)) fail('CA-21: guion contiene .js');
    if (EMOJI.test(v)) fail('CA-11: guion contiene emoji');
    if (MARKDOWN.test(v)) fail('CA-11: guion contiene markdown');
    if (/\d/.test(v)) fail('CA-13: clip pregrabado no puede contener numeros (no lleva hora)');
    if (!/^Aviso del sistema\./.test(v)) fail('falta el encabezado fijo de alerta');
}

console.log(errors ? `\nRESULTADO: ${errors} falla(s)` : '\nRESULTADO: OK — copy valido');
process.exit(errors ? 1 : 0);
