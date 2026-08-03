// =============================================================================
// quota-exhausted-content-channel-5455.test.js — Canal de CONTENIDO de Anthropic
// (#5455, hija de #5424).
//
// `quota-exhausted.js` documenta como invariante que está PROHIBIDO matchear
// contra campos controlados por el modelo. #5424 demostró que existe UN caso
// real sin otro canal: al cortar por límite SEMANAL, el CLI de Anthropic emite
// el aviso como frame final `type:'result'` SIN `is_error` ni `error_type`, así
// que el path estructural lo descarta, el flag nunca se persiste y el fallback
// pre-spawn vuelve a elegir Anthropic (incidente 2026-08-02, ~1h sin Commander).
//
// Esta suite fija las compensaciones que hacen aceptable la excepción — quitar
// cualquiera reabre el DoS auto-infligido por contenido inducido:
//   1. scope Anthropic (allowlist + providerId explícito)
//   2. frame COMPLETO (regex anclado; una mención embebida no matchea)
//   3. shapes cerrados (string, o bloques exclusivamente textuales)
//   4. cota dura de 200 caracteres
//   5. regex anclado con cuantificadores acotados
//   6. tipo dedicado `weekly_limit_content_channel`
//   8. procedencia explícita + excerpt redactado
//
// La compensación 7 (TTL efectivo ≤ 60 min) y el bypass del veto de #4865 se
// cubren en `quota-exhausted-reconcile-4865.test.js`, donde vive el reconcile.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedPipelineConfig } = require('./_test-helpers');

function freshModule(tmpDir) {
    process.env.PIPELINE_DIR_OVERRIDE = tmpDir;
    delete require.cache[require.resolve('../quota-exhausted')];
    return require('../quota-exhausted');
}

function newTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-content-5455-'));
    // #5172: el sandbox ES el `.pipeline/` del test; sin `config.yaml` la
    // lectura de config es un fallo tipado. Documento mínimo.
    seedPipelineConfig(dir);
    return dir;
}

// Texto real del incidente y sus variantes observadas.
const AVISO_SEMANAL = "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)";
const AVISO_CON_FECHA = "You've hit your weekly limit · resets Aug 9, 9pm (America/Buenos_Aires)";
const AVISO_PELADO = "You've hit your weekly limit";

// Reloj fijo: el reset se parsea con `parseResetToIso`, que es sensible al reloj.
const NOW = Date.parse('2026-08-03T12:00:00Z');

function anthropicAllowlist(q) {
    return q.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER.anthropic;
}

// Envuelve el detector con los defaults del caso feliz, para que cada test
// exprese sólo lo que cambia.
function detectar(q, result, opts = {}) {
    const { allowlist, ...rest } = opts;
    return q._detectAnthropicContentChannel(
        { type: 'result', result },
        allowlist === undefined ? anthropicAllowlist(q) : allowlist,
        { providerId: 'anthropic', now: NOW, ...rest },
    );
}

// -----------------------------------------------------------------------------
// Casos POSITIVOS — el aviso real, en sus shapes y variantes observadas
// -----------------------------------------------------------------------------

test('#5455 · frame string del aviso semanal → match con tipo, procedencia y reset', () => {
    const q = freshModule(newTmpDir());

    const r = detectar(q, AVISO_SEMANAL);
    assert.ok(r, 'el aviso real debe matchear');
    assert.equal(r.matched, true);
    assert.equal(r.errorType, 'weekly_limit_content_channel');
    assert.equal(r.errorType, q.WEEKLY_LIMIT_CONTENT_ERROR_TYPE);
    assert.equal(r.source, q.WEEKLY_LIMIT_CONTENT_SOURCE, 'procedencia auditable');
    assert.ok(r.resetsAt && !Number.isNaN(Date.parse(r.resetsAt)), 'reset parseado a ISO');
});

test('#5455 · variantes reales: con mes/dia, pelado y apostrofe tipografico', () => {
    const q = freshModule(newTmpDir());

    assert.ok(detectar(q, AVISO_CON_FECHA), 'con mes/dia debe matchear');
    assert.ok(detectar(q, AVISO_SEMANAL.replace("'", '’')), 'apostrofe curly');

    const pelado = detectar(q, AVISO_PELADO);
    assert.ok(pelado, 'sin clausula de reset debe matchear igual');
    assert.equal(pelado.resetsAt, null, 'sin reset en el texto → null, sin inventar fecha');
});

test('#5455 · whitespace exterior no invalida el match (trim solo exterior)', () => {
    const q = freshModule(newTmpDir());

    assert.ok(detectar(q, `\n\t   ${AVISO_SEMANAL}   \n`), 'debe matchear tras trim');
});

test('#5455 · bloques EXCLUSIVAMENTE textuales → match (shape array)', () => {
    const q = freshModule(newTmpDir());

    const r = detectar(q, [
        { type: 'text', text: "You've hit your weekly limit" },
        { type: 'text', text: ' · resets 9pm (America/Buenos_Aires)' },
    ]);
    assert.ok(r, 'bloques textuales concatenados deben matchear');
    assert.equal(r.errorType, 'weekly_limit_content_channel');
});

// -----------------------------------------------------------------------------
// Casos NEGATIVOS — el vector de DoS auto-infligido
// -----------------------------------------------------------------------------

test('#5455 · mencion embebida en una respuesta larga NO activa el gate', () => {
    const q = freshModule(newTmpDir());

    // EL caso de DoS: un agente que explica el incidente (o un comentario /
    // handoff que lo cite) no debe gatear a Anthropic.
    const largo = `Claro, te explico: cuando aparece "${AVISO_SEMANAL}" el pipeline `
        + 'debe persistir el flag y caer a Codex en el turno siguiente.';
    assert.equal(detectar(q, largo), null);
});

test('#5455 · contenido extra alrededor del aviso NO matchea (frame completo)', () => {
    const q = freshModule(newTmpDir());

    assert.equal(detectar(q, `${AVISO_SEMANAL} and also more text here`), null, 'sufijo');
    assert.equal(detectar(q, `Nota: ${AVISO_SEMANAL}`), null, 'prefijo');
});

test('#5455 · contenido por encima de 200 caracteres NO matchea (cota dura)', () => {
    const q = freshModule(newTmpDir());

    assert.equal(q.WEEKLY_LIMIT_CONTENT_MAX_CHARS, 200);
    const largo = `${AVISO_PELADO} ${'x'.repeat(201 - AVISO_PELADO.length - 1)}`;
    assert.equal(largo.length, 201, 'el caso debe medir exactamente 201');
    assert.equal(detectar(q, largo), null);

    // El regex anclado es una cota AUN mas estricta: ningun aviso valido llega
    // a 200 chars. La cota es defensa en profundidad — garantiza que el regex
    // nunca corra sobre entradas grandes (anti-ReDoS).
    assert.ok(AVISO_CON_FECHA.length < q.WEEKLY_LIMIT_CONTENT_MAX_CHARS);
});

test('#5455 · un solo bloque no textual invalida TODO el frame (fail-closed)', () => {
    const q = freshModule(newTmpDir());

    // No se filtran los bloques textuales "que sirven": eso permitiria esconder
    // el aviso dentro de una respuesta con uso de herramientas.
    assert.equal(detectar(q, [
        { type: 'text', text: AVISO_SEMANAL },
        { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
    ]), null, 'bloque tool_use');
    assert.equal(detectar(q, [
        { type: 'text', text: AVISO_SEMANAL },
        { type: 'image', source: {} },
    ]), null, 'bloque image');
    assert.equal(detectar(q, [{ type: 'text', text: 123 }]), null, 'text no-string');
    assert.equal(detectar(q, []), null, 'array vacio');
    assert.equal(detectar(q, [null]), null, 'bloque null');
});

test('#5455 · mas bloques que el maximo permitido → fail-closed', () => {
    const q = freshModule(newTmpDir());

    const demasiados = Array.from(
        { length: q.WEEKLY_LIMIT_CONTENT_MAX_BLOCKS + 1 },
        () => ({ type: 'text', text: 'a' }),
    );
    assert.equal(detectar(q, demasiados), null);
});

test('#5455 · shapes no contemplados de `result` → null', () => {
    const q = freshModule(newTmpDir());

    for (const raw of [undefined, null, 42, true, { text: AVISO_SEMANAL }]) {
        assert.equal(q._normalizeAnthropicResultContent(raw), null, `shape: ${String(raw)}`);
    }
    assert.equal(q._normalizeAnthropicResultContent(AVISO_SEMANAL), AVISO_SEMANAL, 'string pasa');
});

// -----------------------------------------------------------------------------
// Scope — el path es Anthropic-only por construccion
// -----------------------------------------------------------------------------

test('#5455 · un provider distinto de anthropic NO activa el path', () => {
    const q = freshModule(newTmpDir());

    assert.equal(detectar(q, AVISO_SEMANAL, { providerId: 'openai-codex' }), null);
    assert.equal(detectar(q, AVISO_SEMANAL, { providerId: 'cerebras' }), null);
    // El alias canonico si es aceptado (mismo provider, otro id).
    assert.ok(detectar(q, AVISO_SEMANAL, { providerId: 'anthropic-claude' }));
});

test('#5455 · sin el tipo en la allowlist del provider en uso, el path no aplica', () => {
    const q = freshModule(newTmpDir());

    assert.equal(detectar(q, AVISO_SEMANAL, { allowlist: ['usage_limit_error'] }), null);
    assert.equal(detectar(q, AVISO_SEMANAL, { allowlist: null }), null);
});

test('#5455 · un evento que no es `result` nunca llega al canal de contenido', () => {
    const q = freshModule(newTmpDir());

    const al = anthropicAllowlist(q);
    for (const type of ['assistant', 'system', 'user']) {
        const r = q._detectAnthropic({ type, result: AVISO_SEMANAL }, al, { providerId: 'anthropic' });
        assert.equal(r.matched, false, `type=${type} no debe matchear`);
    }
});

test('#5455 · el tipo dedicado esta en la meta-allowlist SOLO para anthropic', () => {
    const q = freshModule(newTmpDir());

    const tipo = q.WEEKLY_LIMIT_CONTENT_ERROR_TYPE;
    const mapa = q.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER;
    assert.ok(mapa.anthropic.includes(tipo), 'anthropic debe declararlo');
    for (const [prov, tipos] of Object.entries(mapa)) {
        if (prov === 'anthropic') continue;
        assert.ok(!tipos.includes(tipo), `${prov} NO debe declarar el tipo dedicado`);
    }
});

test('#5455 · el tipo dedicado esta sincronizado con agent-models.json', () => {
    const q = freshModule(newTmpDir());

    // Drift entre la meta-allowlist y el JSON hace fail-fast al boot
    // (`agent-models-validate.js`), asi que ambos deben cambiar juntos.
    const modelsPath = path.join(__dirname, '..', '..', 'agent-models.json');
    const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
    const declarados = models.providers.anthropic.quota_error_types;
    assert.ok(
        declarados.includes(q.WEEKLY_LIMIT_CONTENT_ERROR_TYPE),
        'agent-models.json debe declarar weekly_limit_content_channel para anthropic',
    );
    for (const t of declarados) {
        assert.ok(
            q.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER.anthropic.includes(t),
            `${t} debe estar en la meta-allowlist hardcodeada`,
        );
    }
});

// -----------------------------------------------------------------------------
// Procedencia, redaccion y convivencia con el path estructural
// -----------------------------------------------------------------------------

test('#5455 · el excerpt persistido es el contenido normalizado y redactado', () => {
    const q = freshModule(newTmpDir());

    const r = detectar(q, `   ${AVISO_SEMANAL}   `);
    assert.equal(r.rawExcerpt, AVISO_SEMANAL, 'sin whitespace exterior');
    assert.ok(!/[\r\n]/.test(r.rawExcerpt), 'sin saltos de linea (anti log-injection)');
    assert.ok(r.rawExcerpt.length <= q.WEEKLY_LIMIT_CONTENT_MAX_CHARS);
});

test('#5455 · el path estructural de siempre sigue intacto', () => {
    const q = freshModule(newTmpDir());

    const r = q._detectAnthropic(
        {
            type: 'result',
            is_error: true,
            error_type: 'usage_limit_error',
            resets_at: '2026-08-03T20:00:00Z',
        },
        anthropicAllowlist(q),
        { providerId: 'anthropic' },
    );
    assert.equal(r.matched, true);
    assert.equal(r.errorType, 'usage_limit_error', 'el canal de contenido no lo pisa');
});

test('#5455 · _detectAnthropic sin opts conserva el contrato previo', () => {
    const q = freshModule(newTmpDir());

    // Los callers legacy no pasan `opts`; el detector no debe romper.
    const r = q._detectAnthropic({ type: 'result', result: AVISO_SEMANAL }, anthropicAllowlist(q));
    assert.equal(r.matched, true, 'sin providerId el scope lo ancla la allowlist');
    assert.equal(r.errorType, 'weekly_limit_content_channel');
});

// -----------------------------------------------------------------------------
// Barrido del log crudo — fuente compartida por adapter y dispatcher
// -----------------------------------------------------------------------------

test('#5455 · detectWeeklyLimitContentChannelFromLog encuentra el frame en el log crudo', () => {
    const q = freshModule(newTmpDir());

    const log = [
        'no soy json',
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }] } }),
        JSON.stringify({ type: 'result', result: AVISO_SEMANAL }),
    ].join('\n');

    const r = q.detectWeeklyLimitContentChannelFromLog(log, { now: NOW });
    assert.ok(r, 'debe encontrar el frame final');
    assert.equal(r.errorType, 'weekly_limit_content_channel');
    assert.equal(r.source, q.WEEKLY_LIMIT_CONTENT_SOURCE);
    assert.ok(r.resetsAt, 'debe traer el reset ya parseado');
});

test('#5455 · el barrido del log ignora menciones y frames que no son `result`', () => {
    const q = freshModule(newTmpDir());

    const log = [
        JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: AVISO_SEMANAL }] },
        }),
        JSON.stringify({ type: 'result', result: `Te explico: "${AVISO_SEMANAL}" significa corte semanal.` }),
    ].join('\n');

    assert.equal(q.detectWeeklyLimitContentChannelFromLog(log, { now: NOW }), null);
});

test('#5455 · el barrido es defensivo ante entradas vacias o no-string', () => {
    const q = freshModule(newTmpDir());

    for (const raw of ['', null, undefined, 42, {}]) {
        assert.equal(q.detectWeeklyLimitContentChannelFromLog(raw), null, `entrada: ${String(raw)}`);
    }
});
