// =============================================================================
// commander-midturn-quota-5456.test.js — #5456
//
// Cobertura de INTEGRACIÓN del CIERRE DE INTENTO del Commander (`finish()` en
// `.pipeline/pulpo.js`) para el turno perdido por cuota semanal.
//
// El incidente (2026-08-02): el CLI de Anthropic corta por límite SEMANAL y
// emite el aviso como TEXTO del frame final `type:result`, sin `is_error`. Ese
// texto viajaba tal cual a Telegram como si fuera la respuesta del Commander:
// el operador leía el mensaje de cuota de Anthropic —con hora de reset y jerga
// de la cuenta— sin enterarse de que su turno se había perdido.
//
// Qué se ejerce acá, con el contrato REAL de #5455 (nada mockeado del detector):
//
//   CA-1  el texto crudo y toda su metadata quedan suprimidos de la salida.
//   CA-2  la respuesta admite el turno perdido y pide reenviar.
//   CA-6  la clasificación tipada se calcula ANTES de resolver el intento.
//   CA-7  PERSISTENCIA ÚNICA: un solo archivo de estado, un solo slot, sin
//         selector ni flag paralelo.
//   CA-8  el audit del dispatch lleva un ENUM ESTABLE, nunca el `errorType`.
//   CA-9  CONTROL NEGATIVO: un resultado ordinario conserva el camino actual.
//   CA-10 CONTROL NEGATIVO: un resultado incompleto (sin `result`) tampoco se
//         confunde con cuota.
//
// La última sección ancla el WIRING de `pulpo.js` por lectura de fuente: la
// decisión vive dentro de un closure de `attemptAnthropicSpawn` (no exportable
// sin desarmar el turno del Commander), así que el orden de las operaciones —
// que es justo lo que el bug rompía — se verifica sobre el archivo.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderMP = require('../lib/commander/multi-provider');
const quotaExhausted = require('../lib/quota-exhausted');
const { seedPipelineConfig } = require('../lib/__tests__/_test-helpers');

const PULPO_PATH = path.join(__dirname, '..', 'pulpo.js');

// Texto REAL del incidente: es exactamente lo que el operador recibía crudo.
const AVISO_SEMANAL = "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)";

// providerDef de Anthropic tal como lo resuelve `getSkillProviderDef` en pulpo.
function anthropicProviderDef() {
    return {
        launcher: 'claude',
        model: 'claude-sonnet-4-6',
        output_parser: 'anthropic-stream-json',
        quota_error_types: quotaExhausted.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER.anthropic,
        resets_at_cap_max_days: 7,
    };
}

function withTempPipeline(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midturn-5456-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        seedPipelineConfig(tmp);
        process.env.PIPELINE_DIR_OVERRIDE = tmp;
        return fn(tmp);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

// Réplica de la decisión del cierre de intento de `pulpo.js`, armada con los
// MISMOS módulos reales que usa producción. No re-implementa lógica: encadena
// `detectQuotaError` → `isWeeklyLimitContentChannel` → `formatMidTurnQuotaResponse`.
// Si alguno de esos contratos cambia, esto rompe (que es el punto).
function cerrarIntento(evt, { nextProvider = 'openai-codex', lastText = '' } = {}) {
    const det = quotaExhausted.detectQuotaError(evt, anthropicProviderDef());

    const esCuotaSemanal = det.matched === true
        && quotaExhausted.isWeeklyLimitContentChannel('anthropic', det.errorType);

    const quotaMidTurnText = esCuotaSemanal
        ? commanderMP.formatMidTurnQuotaResponse({
            primaryProvider: 'anthropic',
            fallbackProvider: nextProvider,
        })
        : null;

    // Mismo orden de precedencia que `finish()`.
    let resolvedText;
    if (quotaMidTurnText) resolvedText = quotaMidTurnText;
    else if (evt && evt.result) resolvedText = evt.result;
    else if (lastText) resolvedText = lastText;
    else resolvedText = '';

    const errorCode = quotaMidTurnText
        ? commanderMP.QUOTA_MIDTURN_ERROR_CODE
        : (((evt && evt.result) || lastText) ? null : 'no_result');

    return { det, esCuotaSemanal, resolvedText, errorCode };
}

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — el crudo no llega al operador
// -----------------------------------------------------------------------------

test('#5456 CA-1 — el frame de cuota semanal NO devuelve su texto crudo al operador', () => {
    // El frame real: `type:result` con el aviso como CONTENIDO, sin `is_error`.
    const evt = { type: 'result', result: AVISO_SEMANAL };

    // Precondición del incidente: sin #5456, este frame resolvía a su crudo.
    assert.equal(evt.result, AVISO_SEMANAL);

    const { det, esCuotaSemanal, resolvedText } = cerrarIntento(evt);

    assert.equal(det.matched, true, 'el detector de #5455 debe clasificar el frame');
    assert.equal(det.errorType, quotaExhausted.WEEKLY_LIMIT_CONTENT_ERROR_TYPE);
    assert.equal(esCuotaSemanal, true, 'el predicado canónico debe reconocer el subtipo');

    assert.notEqual(resolvedText, AVISO_SEMANAL, 'el crudo NO puede ser la respuesta');
    for (const fuga of [
        AVISO_SEMANAL,
        'weekly limit',
        'resets',
        '9pm',
        'America/Buenos_Aires',
        det.errorType,
        det.source,
        'anthropic-result-content',
    ]) {
        assert.ok(!resolvedText.toLowerCase().includes(String(fuga).toLowerCase()),
            `la respuesta del turno no puede contener "${fuga}" — salida: ${resolvedText}`);
    }
});

test('#5456 CA-2 — la respuesta del turno perdido admite la pérdida y pide reenviar', () => {
    const { resolvedText } = cerrarIntento({ type: 'result', result: AVISO_SEMANAL });

    assert.match(resolvedText, /este turno se perdió/i);
    assert.match(resolvedText, /reenviame el mensaje/i);
    assert.match(resolvedText, /Codex/, 'debe anunciar el proveedor del próximo intento');
});

test('#5456 CA-1 — el excerpt persistido pasa por redacción central', () => {
    const evt = { type: 'result', result: AVISO_SEMANAL };
    const det = quotaExhausted.detectQuotaError(evt, anthropicProviderDef());
    // El detector entrega el excerpt ya saneado (compensación 8 de #5455).
    assert.equal(det.rawExcerpt, quotaExhausted.sanitizeRawExcerpt(AVISO_SEMANAL));
    assert.ok(det.rawExcerpt.length <= quotaExhausted.RAW_EXCERPT_MAX_CHARS);
});

// -----------------------------------------------------------------------------
// CA-9 / CA-10 — controles negativos: el camino ordinario no se toca
// -----------------------------------------------------------------------------

test('#5456 CA-9 — control negativo: un resultado ORDINARIO conserva su texto y errorCode', () => {
    const respuesta = 'Listo, lancé el agente para el issue #5456 y quedó en dev.';
    const { esCuotaSemanal, resolvedText, errorCode } = cerrarIntento({
        type: 'result', result: respuesta,
    });

    assert.equal(esCuotaSemanal, false, 'una respuesta normal NO se clasifica como cuota');
    assert.equal(resolvedText, respuesta, 'el texto del turno pasa intacto');
    assert.equal(errorCode, null, 'sin errorCode: no hubo incidente');
});

test('#5456 CA-9 — control negativo: OTRO tipo de cuota NO sustituye la respuesta del turno', () => {
    // `usage_limit_error` es un tipo de cuota legítimo pero NO es el subtipo del
    // canal de contenido: activa el flag por el camino de siempre y NO dispara
    // la respuesta reactiva de #5456.
    const evt = { type: 'result', is_error: true, error_type: 'usage_limit_error', result: 'boom' };
    const { det, esCuotaSemanal, resolvedText } = cerrarIntento(evt);

    assert.equal(det.matched, true, 'sigue siendo cuota para el detector');
    assert.equal(det.errorType, 'usage_limit_error');
    assert.equal(esCuotaSemanal, false, 'pero NO es el subtipo del canal de contenido');
    assert.equal(resolvedText, 'boom', 'el camino ordinario queda intacto');
});

test('#5456 CA-9 — control negativo: la mención del aviso DENTRO de una respuesta larga no sustituye nada', () => {
    // El vector de DoS auto-infligido: el operador (o un issue) menciona el
    // texto del aviso y el Commander lo repite. No puede activar el gate.
    const largo = `Te resumo el incidente: el CLI devolvió "${AVISO_SEMANAL}" y por eso ` +
        `quedamos sin Commander casi una hora. Lo cubrimos en el issue #5424.`;
    const { esCuotaSemanal, resolvedText } = cerrarIntento({ type: 'result', result: largo });

    assert.equal(esCuotaSemanal, false, 'una mención embebida NO es el frame del aviso');
    assert.equal(resolvedText, largo, 'la respuesta del operador se entrega completa');
});

test('#5456 CA-10 — control negativo: resultado INCOMPLETO (sin result ni texto) no se confunde con cuota', () => {
    const { esCuotaSemanal, resolvedText, errorCode } = cerrarIntento({ type: 'result' });

    assert.equal(esCuotaSemanal, false);
    assert.equal(resolvedText, '');
    assert.equal(errorCode, 'no_result', 'conserva el enum preexistente del turno vacío');
});

// -----------------------------------------------------------------------------
// CA-7 — persistencia ÚNICA por la API canónica
// -----------------------------------------------------------------------------

test('#5456 CA-7 — persistencia única: un archivo de estado, un slot, sin flag paralelo', () => {
    withTempPipeline((tmp) => {
        const evt = { type: 'result', result: AVISO_SEMANAL };
        const det = quotaExhausted.detectQuotaError(evt, anthropicProviderDef());

        const antes = fs.readdirSync(tmp);

        // Única escritura del cierre de intento: la del handler del frame, por
        // la API canónica y con el reset PARSEADO por #5455.
        quotaExhausted.setFlag({
            errorType: det.errorType,
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            resetsAt: det.resetsAt,
            maxDays: anthropicProviderDef().resets_at_cap_max_days,
            agent: 'commander',
            rawExcerpt: det.rawExcerpt,
            auditLogEnabled: false,
        });

        const nuevos = fs.readdirSync(tmp).filter((f) => !antes.includes(f));
        assert.deepEqual(
            nuevos.filter((f) => f.endsWith('.json')).sort(),
            ['quota-exhausted.json'],
            'no se crea ningún otro archivo de estado ni selector paralelo',
        );

        const flag = JSON.parse(fs.readFileSync(path.join(tmp, 'quota-exhausted.json'), 'utf8'));
        assert.equal(flag.exhausted, true);
        assert.deepEqual(Object.keys(flag.providers), ['anthropic'],
            'un solo slot: el del proveedor que se agotó');
        assert.equal(flag.providers.anthropic.pattern_matched,
            quotaExhausted.WEEKLY_LIMIT_CONTENT_ERROR_TYPE);

        // El TTL efectivo queda clampeado por #5455 (60 min), no al reset crudo.
        const ttlMs = Date.parse(flag.providers.anthropic.resets_at) - Date.now();
        const capMs = quotaExhausted.WEEKLY_LIMIT_CONTENT_MAX_DAYS * 24 * 60 * 60 * 1000;
        assert.ok(ttlMs <= capMs + 1000, `TTL ${ttlMs}ms debe respetar el cap de ${capMs}ms`);
    });
});

// -----------------------------------------------------------------------------
// CA-8 — audit con enum estable
// -----------------------------------------------------------------------------

test('#5456 CA-8 — el audit del dispatch lleva el enum estable y NO el errorType ni el crudo', () => {
    withTempPipeline((tmp) => {
        const { errorCode } = cerrarIntento({ type: 'result', result: AVISO_SEMANAL });
        assert.equal(errorCode, commanderMP.QUOTA_MIDTURN_ERROR_CODE);
        assert.equal(errorCode, 'quota_exhausted_midturn');

        commanderMP.auditCommanderRequest({
            pipelineDir: tmp,
            event: 'dispatch',
            providerIntended: 'anthropic',
            providerEffective: 'anthropic',
            chainTried: ['anthropic'],
            chatId: 'chat-5456',
            prompt: 'dame el estado de la ola',
            errorCode,
        });

        const logsDir = path.join(tmp, 'logs');
        const archivos = fs.readdirSync(logsDir).filter((f) => f.startsWith('commander-dispatch-'));
        assert.equal(archivos.length, 1, 'una entrada de audit por dispatch');

        const contenido = fs.readFileSync(path.join(logsDir, archivos[0]), 'utf8');
        assert.ok(contenido.includes('quota_exhausted_midturn'), 'el enum estable sí se audita');
        for (const fuga of [
            quotaExhausted.WEEKLY_LIMIT_CONTENT_ERROR_TYPE,
            'weekly limit',
            '9pm',
            'America/Buenos_Aires',
        ]) {
            assert.ok(!contenido.includes(fuga),
                `el audit del dispatch no puede contener "${fuga}"`);
        }
        // El prompt viaja hasheado, nunca literal (contrato preexistente #3258).
        assert.ok(!contenido.includes('dame el estado de la ola'));
    });
});

// -----------------------------------------------------------------------------
// CA-6 — wiring del cierre de intento en pulpo.js
// -----------------------------------------------------------------------------

test('#5456 CA-6 — pulpo.js clasifica y sustituye ANTES de resolver el intento', () => {
    const src = fs.readFileSync(PULPO_PATH, 'utf8');

    // La clasificación sale del predicado canónico, NO de comparar strings.
    assert.match(src, /quotaExhausted\.isWeeklyLimitContentChannel\(cmdProvider,\s*det\.errorType\)/,
        'la clasificación debe consumir el predicado exportado por #5455');
    assert.doesNotMatch(src, /===\s*['"]weekly_limit_content_channel['"]/,
        'prohibido re-implementar el predicado comparando el literal a mano');

    // El formatter se invoca desde el cierre del intento…
    const idxFormatter = src.indexOf('commanderMP.formatMidTurnQuotaResponse');
    assert.ok(idxFormatter > 0, 'pulpo.js debe usar el formatter de multi-provider');

    // …y la sustitución ocurre ANTES de `resolveAttempt` (el orden ES el fix).
    const idxSustitucion = src.indexOf('resolvedText = quotaMidTurnText');
    const idxResolve = src.indexOf('resolveAttempt({ kind:');
    assert.ok(idxSustitucion > 0, 'debe existir la rama de sustitución del texto');
    assert.ok(idxResolve > 0, 'sanity: resolveAttempt sigue existiendo');
    assert.ok(idxFormatter < idxResolve,
        'el formatter se calcula antes de resolver el intento');
    assert.ok(idxSustitucion < idxResolve,
        'la sustitución ocurre antes de resolver el intento');

    // El enum del audit sale de la constante exportada, no de un literal suelto.
    assert.match(src, /errorCode:\s*quotaMidTurnText[\s\S]{0,120}commanderMP\.QUOTA_MIDTURN_ERROR_CODE/,
        'el audit debe usar el enum estable exportado');

    // El reset persistido es el PARSEADO por #5455 cuando existe.
    assert.match(src, /resetsAt:\s*det\.resetsAt\s*\|\|\s*evt\.resets_at/,
        'el canal de contenido debe persistir su reset parseado');
});

test('#5456 CA-3 — el cierre de intento NO invoca el dedup del aviso proactivo', () => {
    const src = fs.readFileSync(PULPO_PATH, 'utf8');

    // Aislamos el bloque de #5456 dentro de `finish()`: desde su marcador hasta
    // el arranque del audit del dispatch.
    const inicio = src.indexOf('#5456 — CLASIFICACIÓN TIPADA PRIMERO');
    assert.ok(inicio > 0, 'el bloque de #5456 debe existir en el cierre de intento');
    const fin = src.indexOf('#3258 — CA-4 / SR-3: audit log con hash-chain', inicio);
    assert.ok(fin > inicio, 'sanity: el audit sigue después del bloque');

    // Sólo CÓDIGO: los comentarios del bloque documentan justamente por qué NO
    // se llama al dedup, así que nombrarlo ahí no puede hacer fallar el test.
    const codigo = src.slice(inicio, fin)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');

    assert.ok(!/shouldEmitFallbackNotice\s*\(/.test(codigo),
        'la respuesta REACTIVA no puede pasar por el dedup de 5 min del aviso proactivo');
    assert.ok(!/setFlag\s*\(/.test(codigo),
        'persistencia única: el cierre de intento no vuelve a escribir el flag');
    assert.ok(!/writeFileSync\s*\(/.test(codigo),
        'el cierre de intento no escribe estado propio');
    // Sanity del recorte: el bloque de código sí contiene la llamada al formatter.
    assert.ok(/formatMidTurnQuotaResponse\s*\(/.test(codigo),
        'sanity: el recorte del bloque incluye el código del cierre de intento');

    // Y el aviso PROACTIVO conserva su deduplicación intacta.
    assert.match(src, /commanderMP\.shouldEmitFallbackNotice\(\{/,
        'el aviso proactivo sigue dedupeado por shouldEmitFallbackNotice');
});
