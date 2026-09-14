// =============================================================================
// Tests gate1-signature-handler.js — #6207 · camino de escritura de GATE 1.
//
// Cubre:
//   CA-SEC-1 — el click de GATE 1 NUNCA mueve un work-file `waiting-operator/`;
//              la firma sí queda en el audit chain de `operator-signoff-gate`.
//   CA-SEC-3 / D-2.b — depósito con body A + edición a body B (incluida una que
//              cae DESPUÉS de `PRESENTATION_MAX_CHARS`) ⇒ rechazo, sin firma.
//   CA-SEC-5.a — `from.id` no autorizado ⇒ rechazo, cero firmas, binding VIVO.
//   CA-SEC-5.b — `submitSignature` que falla ⇒ binding VIVO, cadena intacta.
//   CA-B4    — allowlist vacía ⇒ ninguna firma válida (fail-closed).
//   CA-B3    — mapeo de verdictos + comentario encolado en reject/re-definition.
//
// Estrategia: NADA de fakes del kernel salvo donde el test necesita forzar un
// fallo. El gate, el canal, el depósito y los dos audit chains son los REALES,
// en un tmpdir hermético con signer de secreto inyectado (sin vault, sin red,
// sin `gh`). Un test contra un doble del kernel probaría el doble, no el camino.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handlerMod = require('../gate1-signature-handler');
const depositMod = require('../gate1-signature-deposit');
const channel = require('../approval-channel');
const operatorGate = require('../operator-gate');
const actionToken = require('../action-token');
const auditLog = require('../audit-log');

const OPERATOR = '987654321';
const INTRUSO = '111000111';
const ISSUE = 6207;
// Material de firma del signer hermético. No es una credencial: el signer real
// resuelve el suyo desde `credentials.js` y nunca sale del proceso.
const CLAVE_DE_PRUEBA = 'material-hmac-de-prueba-6207';

const BODY_A = '## Criterios de aceptación\n\n- [ ] CA-1 el operador firma desde Telegram\n';
const BODY_B = '## Criterios de aceptación\n\n- [ ] CA-1 ALGUIEN EDITÓ ESTO DESPUÉS\n';

/**
 * Entorno hermético completo: gate real + canal real + depósito real, todo bajo
 * un tmpdir. `allowlist` vacía ejercita el fail-closed de CA-B4.
 */
function mkEnv(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-sig-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });

    const allowlist = over.allowlist === undefined ? [OPERATOR] : over.allowlist;

    const companionFile = path.join(dir, 'audit', 'operator-gate-signatures.jsonl');

    const gate = operatorGate.createOperatorGate({
        pipelineDir: dir,
        storeDir: path.join(dir, 'operator-gate', 'pending'),
        waitingDir: path.join(dir, 'desarrollo', 'waiting-operator'),
        approvedDir: path.join(dir, 'desarrollo', 'procesado'),
        rejectedDir: path.join(dir, 'desarrollo', 'pendiente'),
        auditFile: companionFile,
        operatorAllowlist: new Set(allowlist.map(String)),
        signer: actionToken.createTokenSigner({
            secret: CLAVE_DE_PRUEBA,
            nonceFile: path.join(dir, 'audit', 'gate-tokens.jsonl'),
        }),
    });

    const channelDeps = {
        depositDir: path.join(dir, 'approval-channel', 'pendiente'),
        auditFile: path.join(dir, 'audit', 'approval-channel.jsonl'),
        rejectFile: path.join(dir, 'audit', 'approval-channel-rejects.jsonl'),
        rateFile: path.join(dir, 'approval-channel', '.reject-rate.json'),
        signer: actionToken.createTokenSigner({
            secret: CLAVE_DE_PRUEBA,
            nonceFile: path.join(dir, 'audit', 'canal-tokens.jsonl'),
        }),
        auditCompanion: (record) => auditLog.appendChained({
            file: companionFile,
            entry: { ...record, ts: new Date().toISOString() },
        }),
        env: allowlist.length > 0
            ? { TELEGRAM_LEO_OPERATOR_CHAT_ID: allowlist[0] }
            : {},
        config: {
            operator_signoff: { enabled: true, gate_mode: 'enforce' },
            operator_signature: { enabled: true, gate_mode: 'enforce' },
            cua: { operator_chat_ids: [] },
        },
        writerPipelineDir: dir,
    };

    const enqueued = [];
    const logs = [];

    const state = { body: over.body === undefined ? BODY_A : over.body };

    const handler = handlerMod.createGate1SignatureHandler({
        gateFactory: () => gate,
        approvalImpl: over.approvalImpl || channel,
        depositImpl: depositMod,
        channelDeps,
        readIssueBody: over.readIssueBody || (() => state.body),
        enqueueGithub: (payload) => enqueued.push(payload),
        log: (m) => logs.push(m),
    });

    return {
        dir, gate, channelDeps, handler, enqueued, logs, state,
        companionFile,
        // Audit chain REAL del gate de definición: `operator-signoff-gate`
        // escribe en `<pipelineDir>/audit/operator-signoff.jsonl`.
        signoffAuditFile: path.join(dir, 'audit', 'operator-signoff.jsonl'),
        waitingDir: path.join(dir, 'desarrollo', 'waiting-operator'),
        procesadoDir: path.join(dir, 'desarrollo', 'procesado'),
        pendienteDir: path.join(dir, 'desarrollo', 'pendiente'),
        /** Deposita el pedido con el body actual y emite los tres botones. */
        armarEpisodio(body = state.body) {
            const dep = depositMod.depositGate1Request(
                { issue: ISSUE, body, title: 'Firma real de GATE 1' },
                { approvalImpl: channel, channelDeps },
            );
            assert.equal(dep.ok, true, `depósito falló: ${dep.reason}`);
            const ids = {};
            for (const action of ['approve', 'reject', 'adjust-definicion']) {
                ids[action] = gate.register({ issue: ISSUE, action, channelGate: 'definicion' }).callbackData;
            }
            return ids;
        },
        /** Entradas del audit chain del gate de definición. */
        firmasDelGate() {
            if (!fs.existsSync(this.signoffAuditFile)) return [];
            return auditLog.readAll(this.signoffAuditFile);
        },
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } },
    };
}

/** Archivos presentes en un directorio (o `[]` si no existe). */
function listar(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
}

// -----------------------------------------------------------------------------
// CA-SEC-1 · el confused deputy, cerrado
// -----------------------------------------------------------------------------

test('CA-SEC-1: el click de GATE 1 NO mueve el work-file señuelo y sí deja la firma', () => {
    const env = mkEnv();
    try {
        // Señuelo: un ítem de `waiting-operator/` como el que consume GATE 0/2.
        // Si el click cayera en `applyTransition()`, este archivo se movería a
        // `procesado/`. Es exactamente el defecto que el ruteo por
        // `channel_gate` viene a cerrar.
        fs.mkdirSync(env.waitingDir, { recursive: true });
        const señuelo = path.join(env.waitingDir, `${ISSUE}.json`);
        fs.writeFileSync(señuelo, JSON.stringify({ issue: ISSUE, gate: 'señuelo' }), 'utf8');

        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });

        assert.equal(res.ok, true, `la firma debía registrarse: ${res.reason}`);
        assert.equal(res.verdict, 'signed');

        // El señuelo NO se movió: sigue donde estaba y no aparece en destino.
        assert.ok(fs.existsSync(señuelo), 'el work-file NO puede moverse');
        assert.deepEqual(listar(env.procesadoDir), [], 'nada debe llegar a procesado/');
        assert.deepEqual(listar(env.pendienteDir), [], 'nada debe llegar a pendiente/');

        // Y la firma SÍ quedó en el audit chain del gate de definición.
        const firmas = env.firmasDelGate();
        assert.equal(firmas.length, 1, 'debe haber exactamente una firma');
        assert.equal(firmas[0].issue_id, ISSUE);
        assert.equal(firmas[0].verdict, 'signed');
        assert.equal(firmas[0].signed_by, OPERATOR);
    } finally { env.cleanup(); }
});

test('CA-SEC-1: handleSignature RECHAZA un binding de GATE 1 sin consumirlo', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        // Defensa en profundidad: aunque el ruteo del listener fallara y el
        // binding llegara al camino de lifecycle, ahí se rechaza.
        const r = env.gate.handleSignature({ operatorId: OPERATOR, callbackData: ids.approve });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'not-a-lifecycle-binding');
        assert.ok(env.gate.resolve(ids.approve), 'el binding NO se consume');
        assert.deepEqual(env.firmasDelGate(), [], 'no puede quedar ninguna firma');
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-SEC-3 / D-2.b · el ancla es del body completo, no del texto presentado
// -----------------------------------------------------------------------------

test('CA-SEC-3: si el body cambió entre el pedido y el click, NO se firma', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio(BODY_A);
        env.state.body = BODY_B; // alguien editó el issue después del aviso.

        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });

        assert.equal(res.ok, false);
        assert.equal(res.reason, 'stale');
        assert.deepEqual(env.firmasDelGate(), [], 'no puede quedar entrada en el audit chain');
        assert.ok(env.gate.resolve(ids.approve), 'el binding sigue vivo');
    } finally { env.cleanup(); }
});

test('D-2.b: una edición DESPUÉS de PRESENTATION_MAX_CHARS también invalida la firma', () => {
    // Éste es el caso que `presented.digest` NO detecta: el digest presentado es
    // del texto truncado a 3500 chars, así que una edición más allá de ese corte
    // lo deja idéntico. Comparar `anchor.value` (sha256 del body COMPLETO) es lo
    // que cubre los dos casos con una sola condición.
    const relleno = 'x'.repeat(channel.PRESENTATION_MAX_CHARS + 500);
    const largoA = `## Criterios\n\n${relleno}\n\nCOLA-ORIGINAL`;
    const largoB = `## Criterios\n\n${relleno}\n\nCOLA-EDITADA`;

    const env = mkEnv({ body: largoA });
    try {
        const ids = env.armarEpisodio(largoA);

        // Sanity: el digest de lo PRESENTADO es idéntico en ambos bodies — o
        // sea, la comparación ingenua habría dejado pasar la edición.
        const dep = depositMod.readGate1Deposit(ISSUE, {
            approvalImpl: channel, channelDeps: env.channelDeps,
        });
        const anchorB = channel.computeAnchor('definicion', { body: largoB });
        assert.equal(
            dep.presented.digest,
            `sha256:${require('node:crypto').createHash('sha256').update(largoB.slice(0, channel.PRESENTATION_MAX_CHARS), 'utf8').digest('hex')}`,
            'el digest presentado NO distingue las dos versiones (por eso no alcanza)',
        );
        assert.notEqual(dep.anchor.value, anchorB.anchor.value, 'el ancla del body completo sí las distingue');

        env.state.body = largoB;
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });

        assert.equal(res.ok, false);
        assert.equal(res.reason, 'stale');
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

test('sin pendiente depositado no se firma (el pedido tiene que existir)', () => {
    const env = mkEnv();
    try {
        // Se emiten los botones pero NUNCA se depositó el pedido.
        const id = env.gate.register({ issue: ISSUE, action: 'approve', channelGate: 'definicion' }).callbackData;
        const res = env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: id });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'stale');
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-SEC-5 · orden de consumo de los dos nonces
// -----------------------------------------------------------------------------

test('CA-SEC-5.a: un from.id no autorizado no firma NI quema la capability del operador', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();

        const intento = env.handler.handleGate1Signature({
            operatorId: INTRUSO, callbackData: ids.approve,
        });
        assert.equal(intento.ok, false);
        assert.equal(intento.reason, 'unauthorized');
        assert.deepEqual(env.firmasDelGate(), [], 'cero firmas');
        assert.ok(env.gate.resolve(ids.approve), 'el binding sigue VIVO para el operador legítimo');

        // Y el operador legítimo puede firmar después, con el mismo botón.
        const ok = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });
        assert.equal(ok.ok, true, `el operador debía poder firmar: ${ok.reason}`);
        assert.equal(env.firmasDelGate().length, 1);
    } finally { env.cleanup(); }
});

test('CA-SEC-5.a: el toast del rechazo no filtra el callback_data ni el body', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        const r = env.handler.handleGate1Signature({ operatorId: INTRUSO, callbackData: ids.approve });
        assert.doesNotMatch(r.toast, new RegExp(ids.approve));
        assert.doesNotMatch(r.toast, /Criterios de aceptación/);
        for (const linea of env.logs) {
            assert.doesNotMatch(linea, new RegExp(ids.approve), 'el log no puede llevar el callback_data');
        }
    } finally { env.cleanup(); }
});

test('CA-SEC-5.b: si el kernel rechaza la firma, el binding sigue vivo y la cadena intacta', () => {
    const env = mkEnv({
        approvalImpl: {
            ...channel,
            submitSignature: () => ({ ok: false, reason: 'forzado por el test' }),
        },
    });
    try {
        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'rejected-by-kernel');
        assert.equal(res.editMessage, false, 'no se editan los botones de un rechazo');
        assert.ok(env.gate.resolve(ids.approve), 'el binding sobrevive para el reintento');
        assert.ok(env.gate.resolve(ids.reject), 'los otros botones también');
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

test('CA-SEC-5.b: si el kernel LANZA, tampoco se quema el binding', () => {
    const env = mkEnv({
        approvalImpl: {
            ...channel,
            submitSignature: () => { throw new Error('boom C:\\Users\\Administrator\\secreto'); },
        },
    });
    try {
        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'rejected-by-kernel');
        assert.doesNotMatch(res.toast, /boom|Administrator/, 'el error crudo no llega al chat');
        assert.ok(env.gate.resolve(ids.approve));
    } finally { env.cleanup(); }
});

test('fail-closed: si no se puede leer el issue, NO se firma y el binding queda vivo', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        env.state.body = null; // `gh` falló / issue inaccesible.
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'unavailable');
        assert.deepEqual(env.firmasDelGate(), []);
        assert.ok(env.gate.resolve(ids.approve), 'el binding sobrevive');
    } finally { env.cleanup(); }
});

test('un lector de issue que LANZA se trata como indisponible, no como firma', () => {
    const env = mkEnv({ readIssueBody: () => { throw new Error('gh timeout'); } });
    try {
        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'unavailable');
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-B4 · autorización fail-closed
// -----------------------------------------------------------------------------

test('CA-B4: sin allowlist configurada, NINGUNA firma es válida', () => {
    const env = mkEnv({ allowlist: [] });
    try {
        const ids = env.armarEpisodio();
        for (const quien of [OPERATOR, INTRUSO, '', null, undefined, 0]) {
            const r = env.handler.handleGate1Signature({ operatorId: quien, callbackData: ids.approve });
            assert.equal(r.ok, false, `nadie puede firmar sin allowlist (probé ${JSON.stringify(quien)})`);
            assert.equal(r.reason, 'unauthorized');
        }
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

test('CA-B4: un binding de OTRO issue no habilita firmar éste', () => {
    const env = mkEnv();
    try {
        env.armarEpisodio();
        // Botón de un issue distinto: no hay pendiente depositado para él.
        const otro = env.gate.register({ issue: 9999, action: 'approve', channelGate: 'definicion' }).callbackData;
        const r = env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: otro });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'stale');
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

test('un binding de lifecycle (sin channel_gate) NO entra a este handler', () => {
    const env = mkEnv();
    try {
        env.armarEpisodio();
        const legacy = env.gate.register({ issue: ISSUE, action: 'approve' }).callbackData;
        const r = env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: legacy });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'unknown-id');
        assert.ok(env.gate.resolve(legacy), 'sin consumir: su camino es otro');
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

test('un callback_data desconocido se rechaza sin efectos', () => {
    const env = mkEnv();
    try {
        env.armarEpisodio();
        for (const bad of ['deadbeefdeadbeef', '../../etc/passwd', '', null, undefined, 42]) {
            const r = env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: bad });
            assert.equal(r.ok, false);
            assert.equal(r.reason, 'unknown-id');
        }
        assert.deepEqual(env.firmasDelGate(), []);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-B3 · mapeo de verdictos + efecto sobre el issue (D-5)
// -----------------------------------------------------------------------------

test('CA-B3: approve → signed, y se queman los TRES botones del episodio', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });

        assert.equal(res.ok, true);
        assert.equal(res.verdict, 'signed');
        assert.equal(res.editMessage, true);
        assert.equal(res.issue, ISSUE);

        // Los otros dos botones del mismo mensaje ya no pueden emitir un
        // segundo veredicto sobre lo mismo.
        for (const id of Object.values(ids)) {
            assert.equal(env.gate.resolve(id), null, `el binding ${id.slice(0, 4)}… debe estar revocado`);
        }
        // Approve NO encola comentario: el efecto es que el gate deje de retener.
        assert.deepEqual(env.enqueued, []);
        // Y el pendiente se resolvió (el kernel limpia el índice al firmar).
        assert.equal(depositMod.readGate1Deposit(ISSUE, {
            approvalImpl: channel, channelDeps: env.channelDeps,
        }), null);
    } finally { env.cleanup(); }
});

test('CA-B3 / D-5: reject → rejected y encola un comentario en el issue', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.reject,
        });

        assert.equal(res.ok, true);
        assert.equal(res.verdict, 'rejected');
        assert.equal(env.firmasDelGate()[0].verdict, 'rejected');
        assert.equal(env.enqueued.length, 1);
        assert.equal(env.enqueued[0].action, 'comment');
        assert.equal(env.enqueued[0].issue, ISSUE);
        assert.match(env.enqueued[0].body, /rechazó/);
    } finally { env.cleanup(); }
});

test('CA-B3 / D-5: adjust-definicion → re-definition y encola el comentario', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids['adjust-definicion'],
        });

        assert.equal(res.ok, true);
        assert.equal(res.verdict, 're-definition');
        assert.equal(env.firmasDelGate()[0].verdict, 're-definition');
        assert.equal(env.enqueued.length, 1);
        assert.match(env.enqueued[0].body, /re-definición/);
    } finally { env.cleanup(); }
});

test('D-5: el veredicto NO re-encola work-files a criterios', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids.reject });
        // La única orden encolada es el comentario. Nada de work-files.
        assert.equal(env.enqueued.length, 1);
        assert.equal(env.enqueued[0].action, 'comment');
        assert.deepEqual(listar(env.pendienteDir), []);
        assert.deepEqual(listar(env.procesadoDir), []);
    } finally { env.cleanup(); }
});

test('un fallo al encolar el comentario NO invalida la firma ya registrada', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        // Se reemplaza el handler por uno con encolador roto, reusando el gate y
        // el canal del entorno (la firma tiene que quedar igual).
        const h = handlerMod.createGate1SignatureHandler({
            gateFactory: () => env.gate,
            approvalImpl: channel,
            depositImpl: depositMod,
            channelDeps: env.channelDeps,
            readIssueBody: () => env.state.body,
            enqueueGithub: () => { throw new Error('cola llena'); },
            log: (m) => env.logs.push(m),
        });
        const res = h.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids.reject });
        assert.equal(res.ok, true, 'la firma vale aunque el comentario no se encole');
        assert.equal(env.firmasDelGate().length, 1);
    } finally { env.cleanup(); }
});

test('no se puede firmar dos veces el mismo episodio (los botones ya no existen)', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        const primera = env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids.approve });
        assert.equal(primera.ok, true);
        const segunda = env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids.approve });
        assert.equal(segunda.ok, false);
        assert.equal(segunda.reason, 'unknown-id');
        assert.equal(env.firmasDelGate().length, 1, 'una sola firma');
    } finally { env.cleanup(); }
});

test('el mapeo de acciones a verdictos es el enum cerrado esperado', () => {
    assert.deepEqual(handlerMod.VERDICT_POR_ACCION, {
        approve: 'signed',
        reject: 'rejected',
        'adjust-definicion': 're-definition',
    });
});

test('el gate indisponible degrada con toast, sin firmar', () => {
    const h = handlerMod.createGate1SignatureHandler({
        gateFactory: () => { throw Object.assign(new Error('vault cerrado'), { code: 'VAULT_FAILURE' }); },
    });
    const r = h.handleGate1Signature({ operatorId: OPERATOR, callbackData: 'aaaabbbbccccdddd' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unavailable');
    assert.ok(typeof r.toast === 'string' && r.toast.length > 0, 'CA-9: siempre hay toast');
    assert.doesNotMatch(r.toast, /vault|VAULT_FAILURE/i);
});

// -----------------------------------------------------------------------------
// CA-B3 · el efecto REAL sobre el issue: el gate deja de bloquear
// -----------------------------------------------------------------------------
//
// Ésta es la mitad automatizable de CA-B3 ("se firma un GATE 1 real y el issue
// avanza"): que después del click el evaluador que retiene el issue devuelva
// `approve`, o sea que el barrido siguiente lo promueva a `desarrollo`. Sin
// esto, el test sólo probaría que la firma se escribió en un archivo — y una
// firma que el evaluador no reconoce es exactamente el defecto que #6206
// documenta (el canal más ancho que el gate).
//
// La otra mitad —la captura del mensaje de Telegram con el chat id redactado—
// es evidencia manual: requiere al operador real tocando el botón, y no se
// puede fabricar en un test hermético.

const signoffGate = require('../operator-signoff-gate');

/** Corre el evaluador REAL del gate contra el estado del entorno. */
function evaluarGate(env, body) {
    return signoffGate.evaluate({
        issue: { number: ISSUE, createdAt: new Date().toISOString(), labels: ['Ready'] },
        body,
        config: { enabled: true, gate_mode: 'enforce' },
        options: { authorizedSigners: [OPERATOR], pipelineDir: env.dir },
    });
}

test('CA-B3: antes de firmar el gate BLOQUEA; después de firmar deja pasar', () => {
    const env = mkEnv();
    try {
        const antes = evaluarGate(env, BODY_A);
        assert.equal(antes.decision, 'block', 'sin firma el issue queda retenido');

        const ids = env.armarEpisodio();
        const res = env.handler.handleGate1Signature({
            operatorId: OPERATOR, callbackData: ids.approve,
        });
        assert.equal(res.ok, true, res.reason);

        const despues = evaluarGate(env, BODY_A);
        assert.equal(despues.decision, 'approve',
            'con la firma del operador el barrido siguiente promueve el issue');
        assert.equal(despues.verdict, 'signed');
    } finally { env.cleanup(); }
});

test('CA-B3: un reject NO desbloquea el issue (sigue retenido, con route propio)', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids.reject });

        const ev = evaluarGate(env, BODY_A);
        assert.equal(ev.decision, 'block', 'rechazar no promueve');
        assert.equal(ev.verdict, 'rejected');
    } finally { env.cleanup(); }
});

test('CA-B3: adjust-definicion retiene con el route de re-definición', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids['adjust-definicion'] });

        const ev = evaluarGate(env, BODY_A);
        assert.equal(ev.decision, 'block');
        assert.equal(ev.verdict, 're-definition');
        assert.equal(ev.route, 're-definition', 'el route lo distingue de un rechazo normal');
    } finally { env.cleanup(); }
});

test('CA-B3 / anti-TOCTOU: si editan el body DESPUÉS de firmar, el gate vuelve a bloquear', () => {
    const env = mkEnv();
    try {
        const ids = env.armarEpisodio();
        env.handler.handleGate1Signature({ operatorId: OPERATOR, callbackData: ids.approve });
        assert.equal(evaluarGate(env, BODY_A).decision, 'approve');

        // Alguien edita los criterios después de la firma: lo firmado ya no es
        // lo que se promovería. El gate lo detecta por el hash, no por el texto.
        const ev = evaluarGate(env, BODY_B);
        assert.equal(ev.decision, 'block', 'una firma vieja no vale para criterios nuevos');
    } finally { env.cleanup(); }
});
