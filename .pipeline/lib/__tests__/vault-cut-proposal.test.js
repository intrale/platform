'use strict';

// =============================================================================
// Tests del PRODUCTOR de la propuesta de corte del fallback (#5460).
//
// Cubren los criterios de aceptación del issue:
//   - Propone SÓLO con cobertura positiva.
//   - Timeout / Telegram ausente / allowlist vacía / estado indeterminado
//     conservan el fallback, aplican `needs-human` y dejan evidencia local
//     sanitizada.
//   - CERO transiciones de carpetas: los work-files sembrados quedan intactos.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    createVaultCutProposal, buildProposalKeyboard, buildProposalMessage,
    normalizeProposalTimeoutMs, OUTCOME, CUT_ACTION, CUT_BUTTON_TEXT,
    DEFAULT_PROPOSAL_TIMEOUT_MS,
} = require('../vault-cut-proposal');

const T0 = Date.parse('2026-08-28T10:00:00.000Z');

// -----------------------------------------------------------------------------
// Fixture: raíz temporal con las carpetas de cola del pipeline SEMBRADAS.
//
// Sembrarlas es el corazón del test de "cero transiciones": el productor tiene
// que terminar cada rama sin haber tocado un solo byte de ellas.
// -----------------------------------------------------------------------------
function fixture(overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cut-proposal-'));

    // Work-files de todas las colas que un escalado a `needs-human` mal hecho
    // movería (`human-block.reportHumanBlock` renombra el activo).
    const queues = [
        ['desarrollo', 'dev', 'trabajando'],
        ['desarrollo', 'dev', 'pendiente'],
        ['desarrollo', 'waiting-operator'],
        ['desarrollo', 'dev', 'bloqueado-humano'],
    ];
    const seeded = [];
    for (const parts of queues) {
        const dir = path.join(root, ...parts);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, '5460.pipeline-dev');
        fs.writeFileSync(file, 'issue: 5460\n');
        seeded.push(file);
    }

    const calls = {
        needsHuman: [], notified: [], sent: [], registered: [], audits: [],
    };

    const state = {
        fallback: true,
        coverage: { estado: 'cumple', motivo: 'cobertura_completa' },
        allowlist: new Set(['12345']),
        canSend: true,
        sendOk: true,
        registerThrows: false,
        nowMs: T0,
    };

    const producer = createVaultCutProposal({
        pipelineDir: root,
        now: () => state.nowMs,
        runbook: 'docs/operacion-pipeline.md#corte-fallback-vault',
        proposalTimeoutMs: 60 * 60 * 1000,
        gate: {
            register: ({ issue, action }) => {
                if (state.registerThrows) throw new Error('boom /home/leo/.aws/credentials');
                calls.registered.push({ issue, action });
                return { id: 'a'.repeat(16), callbackData: 'a'.repeat(16), token: 'v1.x.y', kind: 'operational' };
            },
        },
        readFallbackState: () => {
            if (state.fallback === 'throw') throw new Error('config ilegible en C:\\Users\\Administrator');
            return state.fallback;
        },
        evaluateCoverage: () => {
            if (state.coverage === 'throw') throw new Error('sidecar roto');
            return state.coverage;
        },
        resolveAllowlist: () => {
            if (state.allowlist === 'throw') throw new Error('allowlist ilegible');
            return state.allowlist;
        },
        canSendTelegram: () => state.canSend,
        sendProposal: (p) => { calls.sent.push(p); return { ok: state.sendOk }; },
        applyNeedsHuman: (issue) => { calls.needsHuman.push(issue); return true; },
        notifyAbsence: (p) => { calls.notified.push(p); return { ok: state.canSend }; },
        appendAudit: (p) => { calls.audits.push(p); },
        ...overrides,
    });

    const snapshot = () => seeded.map((f) => ({
        file: f,
        exists: fs.existsSync(f),
        body: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
    }));

    return {
        root, producer, calls, state, seeded,
        before: snapshot(),
        snapshot,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
        readSignal: () => JSON.parse(fs.readFileSync(producer.paths.signalPath, 'utf8')),
    };
}

/** Ninguna cola del pipeline se movió, renombró ni cambió de contenido. */
function assertCeroTransiciones(fx) {
    assert.deepEqual(fx.snapshot(), fx.before,
        'el productor movió, borró o modificó un work-file del pipeline');
}

// =============================================================================
// Propuesta — sólo con cobertura positiva
// =============================================================================

test('publica la propuesta con cobertura positiva, canal y allowlist', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.PROPUESTA_PUBLICADA);
    assert.equal(res.issue, 5460);
    assert.equal(fx.calls.registered.length, 1);
    assert.equal(fx.calls.registered[0].action, CUT_ACTION);
    assert.equal(fx.calls.sent.length, 1);
    assert.equal(fx.calls.sent[0].replyMarkup.inline_keyboard[0][0].text, CUT_BUTTON_TEXT);
    // No hay escalado: el operador todavía no fue consultado.
    assert.deepEqual(fx.calls.needsHuman, []);
    // El pendiente quedó persistido con deadline.
    const pending = fx.producer.readPending();
    assert.equal(pending.issue, 5460);
    assert.equal(pending.deadline_ms, T0 + 60 * 60 * 1000);
    assertCeroTransiciones(fx);
});

test('cobertura `no_cumple` no propone y NO escala: es una negativa informada', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.coverage = { estado: 'no_cumple', motivo: 'cobertura_incompleta' };

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.ESPERANDO_COBERTURA);
    assert.deepEqual(fx.calls.sent, []);
    assert.deepEqual(fx.calls.needsHuman, [], 'una ventana en curso NO es ausencia del operador');
    assert.equal(fs.existsSync(fx.producer.paths.signalPath), false);
    assertCeroTransiciones(fx);
});

test('cobertura `no_verificado` NO es "todavía no": escala como estado indeterminado', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.coverage = { estado: 'no_verificado', motivo: 'integridad_comprometida' };

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.FAIL_CLOSED);
    assert.equal(res.causa, 'estado_indeterminado');
    assert.deepEqual(fx.calls.sent, []);
    assert.deepEqual(fx.calls.needsHuman, [5460]);
    assertCeroTransiciones(fx);
});

test('el fallback ya cortado es noop y limpia el pendiente', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.producer.runProposalTick({ issue: 5460 });
    assert.ok(fx.producer.readPending(), 'precondición: hay pendiente');

    fx.state.fallback = false;
    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.YA_CORTADO);
    assert.equal(fx.producer.readPending(), null);
    assert.deepEqual(fx.calls.needsHuman, []);
    assertCeroTransiciones(fx);
});

// =============================================================================
// Ausencia del operador — las cuatro causas fallan cerrado
// =============================================================================

test('timeout: la propuesta vence sin confirmación, conserva el fallback y escala', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);

    fx.producer.runProposalTick({ issue: 5460 });
    fx.calls.sent.length = 0;

    // Todavía dentro del plazo: no pasa nada y no se republica el botón.
    fx.state.nowMs = T0 + 59 * 60 * 1000;
    const esperando = fx.producer.runProposalTick({ issue: 5460 });
    assert.equal(esperando.status, OUTCOME.ESPERANDO_CONFIRMACION);
    assert.deepEqual(fx.calls.sent, [], 'republicar el botón en cada tick sería spam');
    assert.deepEqual(fx.calls.needsHuman, []);

    // Vencido.
    fx.state.nowMs = T0 + 60 * 60 * 1000 + 1;
    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.FAIL_CLOSED);
    assert.equal(res.causa, 'timeout');
    assert.equal(res.conserva_fallback, true);
    assert.deepEqual(fx.calls.needsHuman, [5460]);
    assert.equal(fx.readSignal().causa, 'timeout');
    // El pendiente se limpia: si sobreviviera, cada tick volvería a escalar.
    assert.equal(fx.producer.readPending(), null);
    assertCeroTransiciones(fx);
});

test('un timeout ya escalado no vuelve a escalar en el tick siguiente', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.producer.runProposalTick({ issue: 5460 });
    fx.state.nowMs = T0 + 60 * 60 * 1000 + 1;
    fx.producer.runProposalTick({ issue: 5460 });
    assert.equal(fx.calls.needsHuman.length, 1);

    // Sin canal, para que el siguiente tick no vuelva a publicar y el conteo
    // mida exactamente el bucle de timeout que se quiere descartar.
    fx.state.canSend = false;
    fx.state.nowMs = T0 + 61 * 60 * 1000;
    const res = fx.producer.runProposalTick({ issue: 5460 });
    assert.equal(res.causa, 'telegram_ausente', 'ya no hay pendiente: no puede ser timeout');
    assertCeroTransiciones(fx);
});

test('Telegram ausente: no publica, conserva el fallback y deja señal local', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.canSend = false;

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.FAIL_CLOSED);
    assert.equal(res.causa, 'telegram_ausente');
    assert.deepEqual(fx.calls.sent, []);
    assert.deepEqual(fx.calls.needsHuman, [5460]);
    // La señal local es el canal que sobrevive sin Telegram: tiene que existir.
    assert.equal(res.signal_escrita, true);
    assert.equal(fx.readSignal().causa, 'telegram_ausente');
    assertCeroTransiciones(fx);
});

test('el canal que se cae ENTRE la comprobación y el envío también es ausencia', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.sendOk = false;   // canSendTelegram dice sí, el envío falla.

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.FAIL_CLOSED);
    assert.equal(res.causa, 'telegram_ausente');
    assert.equal(fx.producer.readPending(), null,
        'sin propuesta entregada no puede quedar un pendiente esperando confirmación');
    assertCeroTransiciones(fx);
});

test('allowlist vacía: nadie puede confirmar, no se publica el botón', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.allowlist = new Set();

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.FAIL_CLOSED);
    assert.equal(res.causa, 'allowlist_vacia');
    assert.deepEqual(fx.calls.sent, [], 'publicar un botón que rechaza a todos es peor que no publicarlo');
    assert.deepEqual(fx.calls.needsHuman, [5460]);
    assertCeroTransiciones(fx);
});

test('allowlist irresoluble se trata como vacía (nunca fail-open)', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.allowlist = 'throw';

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.causa, 'allowlist_vacia');
    assertCeroTransiciones(fx);
});

test('estado del fallback ilegible o no booleano ⇒ estado indeterminado', (t) => {
    for (const valor of ['throw', undefined, null, 'true', 1, {}]) {
        const fx = fixture();
        try {
            fx.state.fallback = valor;
            const res = fx.producer.runProposalTick({ issue: 5460 });
            assert.equal(res.status, OUTCOME.FAIL_CLOSED, `valor: ${JSON.stringify(valor)}`);
            assert.equal(res.causa, 'estado_indeterminado', `valor: ${JSON.stringify(valor)}`);
            assert.deepEqual(fx.calls.sent, []);
            assertCeroTransiciones(fx);
        } finally { fx.cleanup(); }
    }
});

test('el evaluador de cobertura que explota ⇒ estado indeterminado', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.coverage = 'throw';

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.causa, 'estado_indeterminado');
    assert.deepEqual(fx.calls.sent, []);
    assertCeroTransiciones(fx);
});

test('issue inválido no publica: no hay dónde registrar el escalado', (t) => {
    for (const issue of [0, -1, undefined, 'cinco', 1.5]) {
        const fx = fixture();
        try {
            const res = fx.producer.runProposalTick({ issue });
            assert.equal(res.status, OUTCOME.FAIL_CLOSED, `issue: ${issue}`);
            assert.equal(res.causa, 'estado_indeterminado');
            assert.deepEqual(fx.calls.sent, []);
        } finally { fx.cleanup(); }
    }
});

test('register que explota no publica y no filtra el error al resultado', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.registerThrows = true;

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.causa, 'estado_indeterminado');
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes('credentials'), false);
    assert.equal(serialized.includes('/home/leo'), false);
    assertCeroTransiciones(fx);
});

// =============================================================================
// Señal local — contenido y no-filtración
// =============================================================================

test('la señal local tiene EXACTAMENTE estado, timestamp, causa y runbook', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.canSend = false;

    fx.producer.runProposalTick({ issue: 5460 });
    const signal = fx.readSignal();

    assert.deepEqual(Object.keys(signal).sort(), ['causa', 'estado', 'runbook', 'timestamp']);
    assert.equal(signal.estado, 'fallback_conservado');
    assert.equal(signal.causa, 'telegram_ausente');
    assert.equal(signal.runbook, 'docs/operacion-pipeline.md#corte-fallback-vault');
    assert.equal(signal.timestamp, new Date(T0).toISOString());
});

test('la señal local no filtra paths, chat ids ni el motivo crudo del evaluador', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    // Canarios: si alguno aparece en la señal, algo se está propagando crudo.
    fx.state.coverage = {
        estado: 'no_verificado',
        motivo: 'hosts_activos_invalido',
        hosts: ['DESKTOP-TOTQAUE'],
        error: 'C:\\Users\\Administrator\\.aws\\credentials',
    };
    fx.state.allowlist = new Set(['987654321']);

    fx.producer.runProposalTick({ issue: 5460 });
    const raw = fs.readFileSync(fx.producer.paths.signalPath, 'utf8');

    for (const canario of ['DESKTOP-TOTQAUE', 'Administrator', 'credentials', '987654321', 'hosts_activos_invalido']) {
        assert.equal(raw.includes(canario), false, `la señal filtró: ${canario}`);
    }
});

test('el pendiente corrupto no dispara un timeout fantasma', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fs.mkdirSync(path.dirname(fx.producer.paths.statePath), { recursive: true });
    fs.writeFileSync(fx.producer.paths.statePath, '{ esto no es json');

    const res = fx.producer.runProposalTick({ issue: 5460 });

    assert.equal(res.status, OUTCOME.PROPUESTA_PUBLICADA,
        'un estado ilegible significa "no hay pendiente", no "venció"');
    assertCeroTransiciones(fx);
});

// =============================================================================
// Auditoría
// =============================================================================

test('cada fail-closed queda auditado como decisión fail-closed, nunca auto-proceed', (t) => {
    const fx = fixture();
    t.after(fx.cleanup);
    fx.state.canSend = false;

    fx.producer.runProposalTick({ issue: 5460 });

    const entry = fx.calls.audits.at(-1);
    assert.equal(entry.decision, 'fail-closed');
    assert.equal(entry.clase, CUT_ACTION);
    assert.equal(entry.issue, 5460);
    assert.equal(entry.extra.conserva_fallback, true);
});

test('ninguna rama del productor puede devolver auto-proceed', (t) => {
    const escenarios = [
        (s) => { s.canSend = false; },
        (s) => { s.allowlist = new Set(); },
        (s) => { s.coverage = { estado: 'no_verificado' }; },
        (s) => { s.fallback = 'throw'; },
        (s) => { s.registerThrows = true; },
    ];
    for (const setup of escenarios) {
        const fx = fixture();
        try {
            setup(fx.state);
            fx.producer.runProposalTick({ issue: 5460 });
            for (const a of fx.calls.audits) {
                assert.notEqual(a.decision, 'auto-proceed');
            }
        } finally { fx.cleanup(); }
    }
});

// =============================================================================
// Helpers puros
// =============================================================================

test('el teclado tiene UN solo botón: el silencio ya conserva el fallback', () => {
    const kb = buildProposalKeyboard('deadbeefdeadbeef');
    assert.equal(kb.inline_keyboard.length, 1);
    assert.equal(kb.inline_keyboard[0].length, 1);
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'deadbeefdeadbeef');
    assert.match(kb.inline_keyboard[0][0].text, /Confirmar corte del fallback/);
});

test('el copy de la propuesta no nombra hosts, secretos ni paths absolutos', () => {
    const msg = buildProposalMessage({ runbook: 'docs/operacion-pipeline.md' });
    assert.match(msg, /needs-human/);
    assert.match(msg, /El boton es valido por ~10 min; si expira, el fallback se CONSERVA\./);
    assert.match(msg, /Sin confirmacion, en ~6h el issue queda en needs-human\./);
    assert.match(msg, /Runbook \(incluye el ultimo punto de retorno\): docs\/operacion-pipeline\.md/);
    assert.equal(/[A-Z]:\\/.test(msg), false);
    assert.equal(msg.includes('token'), false);
});

test('el copy deriva la ventana del boton del mismo TTL que gobierna la capability', () => {
    const actionToken = require('../action-token');
    const ttlMinutos = Math.floor(actionToken.maxTtlFor(CUT_ACTION) / 60000);
    const msg = buildProposalMessage({ timeoutMs: 2 * 60 * 60 * 1000 });

    assert.match(msg, new RegExp(`boton es valido por ~${ttlMinutos} min`));
    assert.match(msg, /Sin confirmacion, en ~2h el issue queda en needs-human/);
});

test('el timeout de propuesta rechaza valores fail-open y degrada al default', () => {
    assert.equal(normalizeProposalTimeoutMs(60 * 60 * 1000), 60 * 60 * 1000);
    for (const malo of [0, -1, 1000, 999 * 60 * 60 * 1000, '3600000', null, undefined, 1.5, NaN]) {
        assert.equal(normalizeProposalTimeoutMs(malo), DEFAULT_PROPOSAL_TIMEOUT_MS, `valor: ${malo}`);
    }
});

test('el timeout de propuesta es MAYOR que el TTL criptográfico de la capability', () => {
    // Igualarlos rompe una de las dos cosas: o el token vive horas (superficie
    // de replay), o se escala a needs-human cada 10 minutos (ruido).
    const { OPERATIONAL_TTL_MS } = require('../action-token');
    assert.ok(DEFAULT_PROPOSAL_TIMEOUT_MS > OPERATIONAL_TTL_MS['vault-cut-fallback']);
});

test('el config que se commitea trae los DOS gates cerrados y sin issue', () => {
    // Un merge que deje `proposal_enabled: true` encendería el productor en
    // producción sin que nadie lo haya decidido, y `proposal_issue` apuntando a
    // un número cualquiera etiquetaría `needs-human` sobre trabajo ajeno.
    const yaml = require('js-yaml');
    const cfgPath = path.join(__dirname, '..', '..', 'config.yaml');
    const doc = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
    const cut = doc.vault.cut_fallback;

    assert.equal(cut.proposal_enabled, false, 'el gate de rollout se commitea CERRADO');
    assert.equal(doc.vault.enabled, false, 'el gate del vault se commitea CERRADO');
    assert.equal(cut.proposal_issue, 0, 'el issue del cutover se commitea sin configurar');
    // El timeout sí se commitea con un valor operativo: es calibración, no autoridad.
    assert.equal(normalizeProposalTimeoutMs(cut.proposal_timeout_ms), cut.proposal_timeout_ms,
        'el timeout commiteado tiene que estar dentro de las cotas del módulo');
});

test('la acción del productor es exactamente la operacional de #5458', () => {
    const { OPERATIONAL_ACTIONS } = require('../operator-gate');
    assert.ok(OPERATIONAL_ACTIONS.includes(CUT_ACTION));
    const { GATE_ACTIONS } = require('../operator-gate');
    assert.equal(GATE_ACTIONS.includes(CUT_ACTION), false,
        'el corte nunca puede atravesar el lifecycle');
});
