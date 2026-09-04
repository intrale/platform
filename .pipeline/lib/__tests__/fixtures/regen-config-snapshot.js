#!/usr/bin/env node
// =============================================================================
// regen-config-snapshot.js — #5174 · CA-2
// =============================================================================
//
// Regenera el golden de paridad `config-snapshot-pre-particion.json` a partir de
// la configuración EFECTIVA actual (kernel + producto).
//
// Cuándo corresponde correrlo: cuando un cambio LEGÍTIMO agrega o quita una
// clave de configuración y `config-partition-parity.test.js` se pone en rojo por
// esa razón. NO corresponde correrlo para "hacer pasar" el test: el golden es lo
// único que demuestra que la partición no perdió ninguna clave, así que
// regenerarlo sin mirar el diff convierte al test en decorativo.
//
// El golden es REDACTADO por construcción (path + tipo, nunca el valor), así que
// se puede leer en un PR sin filtrar chat ids, endpoints ni paths de máquina.
//
//   $ node .pipeline/lib/__tests__/fixtures/regen-config-snapshot.js
//
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const resolver = require('../../config-resolver');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DESTINO = path.join(__dirname, 'config-snapshot-pre-particion.json');

const { config, valid, errors } = resolver.resolveMergedForDiff({
    kernelText: fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8'),
    productText: fs.readFileSync(path.join(REPO_ROOT, 'pipeline.config.json'), 'utf8'),
});

if (!config) {
    console.error('[regen] no se pudo resolver la configuración:', JSON.stringify(errors, null, 2));
    process.exit(1);
}
if (!valid) {
    // No se aborta: el golden describe FORMA, y una config inválida igual tiene
    // forma. Pero se avisa fuerte, porque regenerar sobre una config rota
    // congelaría la rotura como si fuera el estado esperado.
    console.warn('[regen] ATENCIÓN: la configuración resuelta NO valida contra el schema.');
    console.warn('[regen] Revisá esto ANTES de commitear el golden:');
    console.warn(JSON.stringify(errors, null, 2));
}

// `_generadoDesde` es el HEAD SOBRE EL QUE se regenero, no el commit que
// contiene el snapshot: se regenera con los cambios en el arbol de trabajo y se
// commitea despues, asi que el marcador apunta naturalmente al padre (#5453
// rev-4, observacion del code review). Para que eso no se lea como una
// inconsistencia, se anota explicitamente si el arbol estaba sucio: "HEAD X +
// cambios sin commitear" describe la situacion real, "X" a secas sugeria —
// falsamente— que el golden salio de ese commit tal cual esta publicado.
let head = '(desconocido)';
try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
        .toString().trim();
    const sucio = execFileSync('git', ['status', '--porcelain', '--', '.pipeline/config.yaml'], { cwd: REPO_ROOT })
        .toString().trim();
    if (sucio) head += ' + cambios sin commitear en .pipeline/config.yaml';
} catch { /* fuera de un checkout git: el golden sigue siendo válido */ }

const previo = fs.existsSync(DESTINO)
    ? JSON.parse(fs.readFileSync(DESTINO, 'utf8'))
    : { snapshot: [] };
const snapshot = resolver.snapshotForDiff(config);

const salida = {
    _doc: previo._doc,
    _generadoDesde: head,
    _claves: snapshot.length,
    snapshot,
};
fs.writeFileSync(DESTINO, JSON.stringify(salida, null, 2) + '\n', 'utf8');

// El diff se imprime para que quien regenera TENGA que mirarlo.
const antes = new Set(previo.snapshot || []);
const ahora = new Set(snapshot);
const agregadas = snapshot.filter((k) => !antes.has(k));
const quitadas = (previo.snapshot || []).filter((k) => !ahora.has(k));

console.log(`[regen] golden actualizado: ${snapshot.length} claves (antes ${antes.size}).`);
if (agregadas.length) console.log('[regen] AGREGADAS:\n  ' + agregadas.join('\n  '));
if (quitadas.length) console.log('[regen] QUITADAS:\n  ' + quitadas.join('\n  '));
if (!agregadas.length && !quitadas.length) console.log('[regen] sin cambios de forma.');
