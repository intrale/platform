'use strict';

// =============================================================================
// provider-cost-v2-wiring-6558.test.js — cableado del libro contable de cuota
// (#6558) en el handler de exit de `pulpo.js` y en la vista de costos.
//
// El módulo `lib/metrics/provider-cost` tiene sus propios tests unitarios; acá
// se verifica que el PUNTO DE INGESTA use el proveedor efectivo (no el
// declarado), pase `fase` y `resultado`, y que `abortada`/`rebote` tengan señal
// en el scope del handler. Patrón idéntico a
// `effective-model-post-exit-wiring.test.js` (lectura de fuente, sin spawn).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');

function exitHandlerBody() {
    const exitStart = source.indexOf("child.on('exit', (code) => {");
    const nextExit = source.indexOf("child.on('exit', (code) => {", exitStart + 1);
    assert.notEqual(exitStart, -1, 'debe existir el exit handler de agentes');
    return source.slice(exitStart, nextExit === -1 ? source.length : nextExit);
}

function costBlock() {
    const body = exitHandlerBody();
    const start = body.indexOf("require('./lib/metrics/provider-cost')");
    assert.notEqual(start, -1, 'el exit handler debe registrar costo por provider');
    const end = body.indexOf('}, 500);', start);
    assert.notEqual(end, -1);
    return body.slice(start, end);
}

test('CA-1: el costo se atribuye al proveedor EFECTIVO (launchResult → dispatchResolution → declarado)', () => {
    const block = costBlock();
    const idxLaunch = block.indexOf('launchResult.provider');
    const idxDispatch = block.indexOf('dispatchResolution.provider');
    const idxDeclared = block.indexOf('resolveSkillProvider(skill)');
    assert.ok(idxLaunch !== -1 && idxDispatch !== -1 && idxDeclared !== -1,
        'deben participar las tres fuentes, en ese orden de precedencia');
    assert.ok(idxLaunch < idxDispatch && idxDispatch < idxDeclared,
        'el declarado (`resolveSkillProvider`) sólo puede ser el último fallback');
});

test('CA-3: la línea lleva fase y resultado del enum, y el resultado sale de las señales del handler', () => {
    const block = costBlock();
    assert.match(block, /recordProviderCost\(\{[\s\S]*?\bfase,[\s\S]*?\}\)/, 'debe pasar `fase`');
    assert.match(block, /resultado:\s*resultadoPc/, 'debe pasar `resultado`');
    assert.match(block, /duration_ms:/, '`duration_ms` es el campo canónico (no `latency_ms`)');
    assert.doesNotMatch(block, /latency_ms:/);
    assert.doesNotMatch(block, /status:\s*code === 0/, 'el vocabulario v1 (`status`) ya no se emite');
    // Mapeo: abortada (watchdog) > rebote (cuota) > ganada (exit 0) > error.
    const iAbort = block.indexOf("resultadoPc = 'abortada'");
    const iRebote = block.indexOf("resultadoPc = 'rebote'");
    const iGanada = block.indexOf("resultadoPc = 'ganada'");
    assert.ok(iAbort !== -1 && iRebote !== -1 && iGanada !== -1);
    assert.ok(iAbort < iRebote && iRebote < iGanada, 'precedencia abortada > rebote > ganada');
    assert.match(block, /killedByTimeoutWatchdog/);
    assert.match(block, /veredictoDeAutenticacion[\s\S]{0,80}errorClass === 'quota_exhausted'/);
    assert.match(block, /cache_read:\s*tkPc\.cache_read/);
    assert.match(block, /cache_write:\s*tkPc\.cache_create/);
});

test('abortada: el watchdog de timeout deja una señal local que el handler de exit puede leer', () => {
    const watchdogStart = source.indexOf('const watchdog = setTimeout(() => {');
    const watchdogEnd = source.indexOf("child.on('exit', (code) => {", watchdogStart);
    const watchdogBody = source.slice(watchdogStart, watchdogEnd);
    assert.match(watchdogBody, /killedByTimeoutWatchdog = true/);
    // La declaración vive ANTES del watchdog, en el scope de lanzarAgenteClaude.
    const decl = source.lastIndexOf('let killedByTimeoutWatchdog = false;', watchdogStart);
    const fnStart = source.lastIndexOf('async function lanzarAgenteClaude(', watchdogStart);
    assert.ok(decl !== -1 && decl > fnStart, 'flag declarado en el scope de la función de lanzamiento');
    // El writer no depende del watchdog (mismo invariante que #6273).
    assert.doesNotMatch(watchdogBody, /recordProviderCost\s*\(/);
});

test('una línea por corrida: el registro NO está condicionado a `traceHandle` (las determinísticas también se anotan)', () => {
    const body = exitHandlerBody();
    const ifTrace = body.indexOf('if (traceHandle) {');
    // Cabecera del bloque de costo (antes de su propio `try {`).
    const cost = body.indexOf('// #4403 (D4 · CA-D · H2 · RS-3) — telemetría de costo por provider.');
    assert.ok(ifTrace !== -1 && cost !== -1 && ifTrace < cost);
    // El cierre del `if (traceHandle)` tiene que estar entre el `if` y el bloque de costo.
    const between = body.slice(ifTrace, cost);
    const openBraces = (between.match(/\{/g) || []).length;
    const closeBraces = (between.match(/\}/g) || []).length;
    assert.ok(closeBraces >= openBraces, 'el bloque de costo debe quedar fuera del `if (traceHandle)`');
});

test('vista Costos: informa el histórico v1 aparte, con el copy de UX, y no lo mezcla con el desglose', () => {
    const costos = require('../views/dashboard/costos.js');
    const soloHistorico = {
        providerCostLog: {
            hasData: false, byProvider: {}, totalSessions: 0,
            hasUnreliable: true, unreliable: { sessions: 14253, tokens_in: 1, tokens_out: 1 },
        },
    };
    const html = costos.renderCostosRedesign(soloHistorico);
    assert.match(html, /Sin registros de costo por proveedor todavía/);
    assert.match(html, /14\.253<\/b> corridas anteriores sin proveedor confiable/);

    const mezcla = {
        providerCostLog: {
            hasData: true, totalSessions: 1,
            byProvider: { 'openai-codex': { tokens_in: 10, tokens_out: 5, sessions: 1, errors: 0, rebotes: 0, abortadas: 0 } },
            hasUnreliable: true, unreliable: { sessions: 1, tokens_in: 1, tokens_out: 1 },
        },
    };
    const html2 = costos.renderCostosRedesign(mezcla);
    assert.match(html2, /OpenAI \/ Codex/);
    assert.match(html2, /<b>1<\/b> corrida anterior sin proveedor confiable/);

    const sinHistorico = { providerCostLog: { hasData: false, byProvider: {}, totalSessions: 0, hasUnreliable: false, unreliable: { sessions: 0 } } };
    assert.doesNotMatch(costos.renderCostosRedesign(sinHistorico), /sin proveedor confiable/);
});
