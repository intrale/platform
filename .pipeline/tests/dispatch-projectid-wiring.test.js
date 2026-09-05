// =============================================================================
// dispatch-projectid-wiring.test.js — Issue #5901 · CA-3 (GURU-1)
//
// **Este test existe porque el CA del `grep` no puede fallar.**
//
// Agregar `opts.projectId` + `SCOPES_BY_FASE` a `build-child-env.js` hace que
// `grep -c projectId` deje de devolver `0` SIN tocar un solo caller. En runtime
// `fase` y `projectId` llegarían `undefined`, la resolución caería al
// fail-closed y el least-privilege por fase NO existiría. El criterio hay que
// verificarlo sobre el CALLSITE, no sobre el módulo.
//
// `pulpo.js` son ~16k líneas con efectos de arranque: no se puede `require`
// para probar el dispatch. La verificación es ESTÁTICA sobre el fuente, pero no
// es un `grep`: parsea cada invocación real, extrae su objeto de opciones
// balanceando llaves y comprueba que el eje esté ahí. Un callsite nuevo que se
// olvide de pasarlo rompe este test — que es exactamente lo que se quiere.
//
// Complementa a `dispatch-build-env-integration.test.js` (#3198), que verifica
// la COMPOSICIÓN dispatcher → buildChildEnv replicando el flujo con fakes. Ese
// replica lo que pulpo.js hace; éste verifica que pulpo.js lo haga de verdad.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PULPO = path.resolve(__dirname, '..', 'pulpo.js');
const fuente = fs.readFileSync(PULPO, 'utf8');

/**
 * Extrae los objetos literales pasados a `buildChildEnvLib.buildChildEnv({...})`
 * balanceando llaves (un regex no sirve: los literales tienen objetos anidados).
 * Ignora las líneas comentadas.
 */
function callsitesDeBuildChildEnv(src) {
    const MARCA = 'buildChildEnvLib.buildChildEnv({';
    const encontrados = [];
    let desde = 0;
    for (;;) {
        const i = src.indexOf(MARCA, desde);
        if (i === -1) break;
        desde = i + MARCA.length;

        // Descartar ocurrencias dentro de un comentario de línea.
        const inicioLinea = src.lastIndexOf('\n', i) + 1;
        const prefijo = src.slice(inicioLinea, i);
        if (prefijo.trimStart().startsWith('//') || prefijo.includes('// ')) continue;

        // Balanceo desde la `{` de apertura del objeto de opciones.
        let nivel = 0;
        let j = i + MARCA.length - 1;
        for (; j < src.length; j++) {
            if (src[j] === '{') nivel += 1;
            else if (src[j] === '}') {
                nivel -= 1;
                if (nivel === 0) break;
            }
        }
        encontrados.push({
            linea: src.slice(0, i).split('\n').length,
            opciones: src.slice(i + MARCA.length - 1, j + 1),
        });
    }
    return encontrados;
}

/** Claves de primer nivel del literal (ignora comentarios y anidados). */
function clavesDePrimerNivel(literal) {
    const cuerpo = literal.slice(1, -1);
    const claves = [];
    let nivel = 0;
    let linea = '';
    const empujar = () => {
        const limpia = linea.replace(/\/\/.*$/, '').trim();
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(limpia) || /^([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(limpia);
        if (m) claves.push(m[1]);
        linea = '';
    };
    for (const ch of cuerpo) {
        if (ch === '{' || ch === '[' || ch === '(') nivel += 1;
        if (ch === '}' || ch === ']' || ch === ')') nivel -= 1;
        if (ch === '\n' || (ch === ',' && nivel === 0)) { empujar(); continue; }
        linea += ch;
    }
    empujar();
    return claves;
}

// ─── El eje llega a TODOS los callsites reales ───────────────────────────────

test('CA-3: hay al menos un callsite productivo de buildChildEnv en pulpo.js', () => {
    const sitios = callsitesDeBuildChildEnv(fuente);
    assert.ok(sitios.length >= 2,
        `se esperaban >= 2 callsites (dispatch + commander), se encontraron ${sitios.length}`);
});

test('CA-3: TODOS los callsites de buildChildEnv pasan `fase` y `projectId`', () => {
    const sitios = callsitesDeBuildChildEnv(fuente);
    for (const sitio of sitios) {
        const claves = clavesDePrimerNivel(sitio.opciones);
        assert.ok(claves.includes('fase'),
            `pulpo.js:${sitio.linea} — callsite de buildChildEnv sin \`fase\`: `
            + 'el techo por fase quedaria en fail-closed y el hijo perderia scopes. '
            + `Claves presentes: [${claves.join(', ')}]`);
        assert.ok(claves.includes('projectId'),
            `pulpo.js:${sitio.linea} — callsite de buildChildEnv sin \`projectId\`. `
            + `Claves presentes: [${claves.join(', ')}]`);
    }
});

test('CA-3: el dispatch por issue pasa la `fase` VIVA, no un literal hardcodeado', () => {
    const sitios = callsitesDeBuildChildEnv(fuente);
    const dispatch = sitios.find((s) => /(^|\n)\s*skill,\s*(\n|$)/.test(s.opciones));
    assert.ok(dispatch, 'no se encontro el callsite del dispatch por issue (shorthand `skill,`)');
    // `fase` shorthand = la variable viva del bloque, no una constante.
    assert.match(dispatch.opciones, /(^|\n)\s*fase,\s*(\n|$)/,
        'el dispatch debe pasar la variable `fase` del despacho, no un literal');
    assert.match(dispatch.opciones, /projectId:\s*projectIdDelSpawn/,
        'el dispatch debe pasar el projectId resuelto, no una constante');
});

test('GURU-3: el spawn del commander pasa la fase sintetica y el slug del kernel', () => {
    const sitios = callsitesDeBuildChildEnv(fuente);
    const commander = sitios.filter((s) => /COMMANDER_SKILL/.test(s.opciones));
    assert.ok(commander.length >= 1, 'no se encontro el callsite del commander');
    for (const sitio of commander) {
        assert.match(sitio.opciones, /fase:\s*buildChildEnvLib\.KERNEL_FASE/,
            `pulpo.js:${sitio.linea} — el commander debe usar KERNEL_FASE (no tiene fase de pipeline)`);
        assert.match(sitio.opciones, /projectId:\s*buildChildEnvLib\.KERNEL_PROJECT_ID/,
            `pulpo.js:${sitio.linea} — el commander debe usar el slug reservado del kernel`);
    }
});

// ─── CA-1 · el env NO es autoridad ───────────────────────────────────────────

test('CA-1: el projectId del dispatch se resuelve por project-context, no del env', () => {
    const i = fuente.indexOf('const projectIdDelSpawn');
    assert.ok(i > 0, 'no se encontro la resolucion del projectId del spawn');
    const bloque = fuente.slice(i, i + 1400);
    assert.match(bloque, /resolveProjectContext\(\)/,
        'el projectId autoritativo sale de project-context.resolveProjectContext()');
    assert.doesNotMatch(bloque, /process\.env\.PIPELINE_PROJECT_ID/,
        'el env es TRANSPORTE, no autoridad (#5110 SEC-1): no puede ser la fuente');
});

test('CA-1: la resolucion del projectId no rompe el spawn cuando el binding es null', () => {
    const i = fuente.indexOf('const projectIdDelSpawn');
    const bloque = fuente.slice(i, i + 1400);
    assert.match(bloque, /try\s*\{/, 'la resolucion debe estar protegida');
    assert.match(bloque, /catch/, 'un contexto irresoluble no puede tumbar el spawn');
    assert.match(bloque, /KERNEL_PROJECT_ID/,
        'debe existir una caida explicita al namespace del kernel');
});

test('#5110: pipelineExtras sigue emitiendo el par PIPELINE_PROJECT_ID + BINDING', () => {
    // No-regresion: el eje nuevo no puede haber desarmado el transporte previo.
    assert.match(fuente, /PIPELINE_PROJECT_ID:\s*projectBinding\.projectId/);
    assert.match(fuente, /PIPELINE_PROJECT_BINDING:\s*projectBinding\.nonce/);
});

// ─── Diagnóstico cableado (CA-4) ────────────────────────────────────────────

test('CA-4: los callsites cablean `warn` al log del pulpo (el fail-closed no es mudo)', () => {
    const sitios = callsitesDeBuildChildEnv(fuente);
    for (const sitio of sitios) {
        assert.match(sitio.opciones, /warn:\s*\(m\)\s*=>\s*log\(/,
            `pulpo.js:${sitio.linea} — sin \`warn\` cableado, un techo faltante se pierde en stderr`);
    }
});

// ─── Coherencia con el módulo ────────────────────────────────────────────────

test('CA-3: las constantes que usan los callsites existen en el modulo', () => {
    const lib = require('../lib/build-child-env');
    assert.equal(typeof lib.KERNEL_FASE, 'string');
    assert.equal(typeof lib.KERNEL_PROJECT_ID, 'string');
    assert.ok(Object.prototype.hasOwnProperty.call(lib.SCOPES_BY_FASE, lib.KERNEL_FASE),
        'KERNEL_FASE debe tener techo declarado, si no el commander cae al fail-closed');
});
