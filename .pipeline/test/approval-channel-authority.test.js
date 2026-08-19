// =============================================================================
// Tests approval-channel.js — AUTORIDAD DE FIRMA (#6206, rebote rev-1)
// =============================================================================
//
// Regresión del hallazgo [Alta][OWASP A01 · Broken Access Control] de la fase de
// verificación: `submitSignature()` reenviaba `p.writerOptions` TAL CUAL al
// writer del gate, y ese objeto es *exactamente* el que decide la autorización
// del firmante (`normalizeAuthorizedSigners(options.authorizedSigners)`).
//
// Por esa misma vía viajaban además:
//   - `pipelineDir` → redirigía el audit chain de NO REPUDIO,
//   - `fsImpl`      → sustituía el filesystem,
//   - `rateLimit`   → anulaba el rate-limit CA-11,
//   - `now`/`nowISO`→ falsificaban el `signed_at`.
//
// Impacto demostrado en el PoC del rechazo: DoS del gate (una firma espuria
// escrita ENCIMA de la legítima invierte `evaluate()` de approve a block, porque
// `evalSignature` mira la más reciente) y envenenamiento del chain con entradas
// que aparentan firmas humanas en `enforce`.
//
// Estos tests cementan el invariante: **el cliente aporta sólo `{verdict, nonce}`
// + material fuente; la autoridad sobre quién firma es del kernel, resuelta
// server-side.**
//
// También cubren los hallazgos acompañantes del mismo rechazo:
//   [A01/A02] el token bearer no se persiste en el depósito ni lo expone listPending.
//   [A05]     `verify()` no es total (#5461) ⇒ no debe tumbar el proceso adaptador.
//   [A04/A08] store de nonces ilegible ⇒ NO revalida un token ya consumido.
//   [A04]     consumo del nonce con reclamo atómico entre procesos.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const channel = require('../lib/approval-channel');
const actionToken = require('../lib/action-token');
const auditLog = require('../lib/audit-log');
const signoffGate = require('../lib/operator-signoff-gate');

const OPERATOR = '12345678';
const IMPOSTOR = '999999-impostor';
const SECRET = 'secreto-de-test-6206-authority';
const BODY = '## Criterios\n\n- [ ] CA-1 la autoridad de firma es del kernel\n';

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/**
 * Entorno hermético. `deps` es el cableado SERVER-SIDE (lo que en producción
 * pone el proceso, no el cliente): de ahí sale el env con el operador
 * autorizado. El payload del cliente se arma aparte, en `submit`.
 */
function mkEnv(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-authority-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    const deps = {
        depositDir: path.join(dir, 'approval-channel', 'pendiente'),
        auditFile: path.join(dir, 'audit', 'approval-channel.jsonl'),
        rejectFile: path.join(dir, 'audit', 'approval-channel-rejects.jsonl'),
        rateFile: path.join(dir, 'approval-channel', '.reject-rate.json'),
        signer: actionToken.createTokenSigner({
            secret: SECRET,
            nonceFile: path.join(dir, 'audit', 'canal-tokens.jsonl'),
        }),
        auditCompanion: (record) => auditLog.appendChained({
            file: path.join(dir, 'audit', 'operator-gate-signatures.jsonl'),
            entry: { ...record, ts: new Date().toISOString() },
        }),
        // El operador real, resuelto server-side (misma fuente que el camino de
        // botones: `operator-gate.resolveOperatorAllowlist`).
        env: { TELEGRAM_LEO_OPERATOR_CHAT_ID: OPERATOR },
        writerPipelineDir: dir,
        ...(over.deps || {}),
    };
    return {
        dir,
        deps,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
    };
}

function request(env, over = {}) {
    const res = channel.requestSignature(
        { gate: 'definicion', issue: 6206, body: BODY, gateMode: 'enforce', ...over }, env.deps,
    );
    assert.equal(res.ok, true, `requestSignature falló: ${res.reason}`);
    return res;
}

function submit(env, req, over = {}) {
    return channel.submitSignature({
        gate: 'definicion',
        issue: 6206,
        token: req.request.token,
        verdict: 'signed',
        signedBy: OPERATOR,
        body: BODY,
        gateMode: 'enforce',
        ...over,
    }, env.deps);
}

/** Payload de auto-autorización, tal cual el PoC del rechazo. */
function autoAutorizacion(dir, quien) {
    return {
        signedBy: quien,
        writerOptions: { pipelineDir: dir, authorizedSigners: [quien] },
        // Por si algún día se leyera de otro nombre: ninguno debe autorizar.
        options: { authorizedSigners: [quien] },
        authorizedSigners: [quien],
    };
}

// -----------------------------------------------------------------------------
// A01 · quién puede firmar lo decide el kernel
// -----------------------------------------------------------------------------

test('#6206/A01: el cliente que inyecta su propia allowlist NO puede firmar', () => {
    const env = mkEnv();
    try {
        const res = submit(env, request(env), autoAutorizacion(env.dir, IMPOSTOR));

        assert.equal(res.ok, false, 'el impostor no puede firmar auto-autorizándose');
        assert.match(res.reason, /no autorizado/i);
        // El chain de no repudio quedó limpio: ninguna entrada espuria.
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest, null);
    } finally { env.cleanup(); }
});

test('#6206/A01: el DoS del gate queda cerrado — la firma legítima no se puede tapar', () => {
    const env = mkEnv();
    try {
        // 1 · el operador real firma.
        const ok = submit(env, request(env));
        assert.equal(ok.ok, true, `la firma legítima debería entrar: ${ok.reason}`);
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest.signed_by, OPERATOR);

        // 2 · el impostor intenta escribir ENCIMA. `evalSignature` mira la firma
        //     MÁS RECIENTE, así que antes esto invertía el veredicto a `block`.
        const dos = submit(env, request(env), autoAutorizacion(env.dir, IMPOSTOR));
        assert.equal(dos.ok, false);

        // 3 · la última firma del chain sigue siendo la del operador.
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest.signed_by, OPERATOR);
    } finally { env.cleanup(); }
});

test('#6206/A01: sin operador configurado server-side, NADIE firma (fail-closed)', () => {
    const env = mkEnv({ deps: { env: {} } });
    try {
        const res = submit(env, request(env));
        assert.equal(res.ok, false, 'sin allowlist server-side no se firma');
        assert.match(res.reason, /no autorizado/i);
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest, null);
    } finally { env.cleanup(); }
});

test('#6206/A01: el `pipelineDir` del cliente NO redirige el audit chain del gate', () => {
    const env = mkEnv();
    try {
        const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-authority-desvio-'));
        try {
            const res = submit(env, request(env), {
                writerOptions: { pipelineDir: otro, authorizedSigners: [OPERATOR] },
                pipelineDir: otro,
            });
            assert.equal(res.ok, true, `la firma del operador debería entrar: ${res.reason}`);

            // Cayó donde manda el kernel, no donde pidió el cliente.
            assert.equal(signoffGate.readSignatureState(6206, env.dir).latest.signed_by, OPERATOR);
            assert.equal(signoffGate.readSignatureState(6206, otro).latest, null);
        } finally { fs.rmSync(otro, { recursive: true, force: true }); }
    } finally { env.cleanup(); }
});

test('#6206/A08: el cliente no puede falsificar el `signed_at` del chain de no repudio', () => {
    const env = mkEnv();
    try {
        const antes = Date.now();
        const res = submit(env, request(env), {
            writerOptions: {
                pipelineDir: env.dir,
                authorizedSigners: [OPERATOR],
                nowISO: '2030-01-01T00:00:00.000Z',
                now: Date.parse('2030-01-01T00:00:00.000Z'),
            },
            nowISO: '2030-01-01T00:00:00.000Z',
        });
        assert.equal(res.ok, true, `la firma del operador debería entrar: ${res.reason}`);

        const firmada = signoffGate.readSignatureState(6206, env.dir).latest;
        const ts = Date.parse(firmada.signed_at);
        assert.ok(Number.isFinite(ts), 'signed_at debe ser una fecha válida');
        assert.ok(ts >= antes && ts <= Date.now() + 5000,
            `signed_at inyectado por el cliente: ${firmada.signed_at}`);
    } finally { env.cleanup(); }
});

test('#6206/CA-11: el cliente no puede anular el rate-limit de firma del gate', () => {
    const env = mkEnv();
    try {
        // El writer del gate corta a las 3 firmas por ventana (DEFAULT_RATE_LIMIT).
        // El cliente intenta abrir el límite a 9999 por `writerOptions`.
        const abrir = { writerOptions: { pipelineDir: env.dir, authorizedSigners: [OPERATOR], rateLimit: { maxPerWindow: 9999 } } };
        let ultimas = null;
        for (let i = 0; i < 8; i += 1) {
            ultimas = submit(env, request(env), abrir);
            if (!ultimas.ok) break;
        }
        assert.equal(ultimas.ok, false, 'el rate-limit del gate debe seguir cortando');
        assert.match(ultimas.reason, /rate-limit/i);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// A01/A02 · el token bearer no se persiste ni se expone
// -----------------------------------------------------------------------------

test('#6206/A02: el token NO se persiste en el depósito ni lo expone listPending', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        const token = req.request.token;
        assert.ok(typeof token === 'string' && token.length > 0, 'el caller sí recibe el token');

        // En disco no está.
        const crudo = fs.readFileSync(req.path, 'utf8');
        assert.equal(crudo.includes(token), false, 'el token quedó escrito en el depósito');
        assert.equal(JSON.parse(crudo).token, undefined);

        // Y el índice que van a leer dashboard (#6208) y Telegram (#6207) tampoco.
        const listado = channel.listPending({ gateMode: 'enforce' }, env.deps);
        assert.equal(listado.degraded, false);
        assert.equal(JSON.stringify(listado.pending).includes(token), false,
            'listPending expone el token: quien lee el índice podría firmar');

        // Y el token devuelto en memoria sigue sirviendo.
        assert.equal(submit(env, req).ok, true);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// A05 · `verify()` no es total (#5461) — no debe tumbar el adaptador
// -----------------------------------------------------------------------------

test('#6206/A05: si el verificador de token LANZA, se rechaza sin propagar la excepción', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        env.deps.signer = {
            sign: () => 'v1.x.y',
            verify: () => { const e = new Error('vault cerrado'); e.code = 'VAULT_DISABLED'; throw e; },
        };
        const res = submit(env, req);   // no debe lanzar
        assert.equal(res.ok, false);
        assert.match(res.reason, /no disponible|VAULT_DISABLED/i);
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest, null);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// A04/A08 · store de nonces — fail-closed y reclamo atómico
// -----------------------------------------------------------------------------

test('#6206/A04: store de nonces ILEGIBLE ⇒ el token consumido NO vuelve a valer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-token-store-'));
    try {
        const nonceFile = path.join(dir, 'nonces.jsonl');
        const signer = actionToken.createTokenSigner({ secret: SECRET, nonceFile });

        const token = signer.sign({ issue: 6206, action: 'approve' });
        assert.equal(signer.verify(token).ok, true, '1er uso vale');
        assert.equal(signer.verify(token).reason, 'replayed', '2do uso es replay');

        // Store ilegible (EISDIR: el path pasa a ser un directorio). Antes, el
        // `catch` desnudo lo trataba como "ningún nonce usado" ⇒ ok:true.
        fs.rmSync(nonceFile);
        fs.mkdirSync(nonceFile);

        assert.throws(() => signer.verify(token), (e) => e && e.code !== 'ENOENT',
            'con el store ilegible debe fallar cerrado, no revalidar el token');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#6206/A04: el nonce se reclama ATÓMICAMENTE (cierra la carrera entre procesos)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-token-claim-'));
    try {
        const nonceFile = path.join(dir, 'nonces.jsonl');
        const signer = actionToken.createTokenSigner({ secret: SECRET, nonceFile });

        const token = signer.sign({ issue: 6206, action: 'approve' });
        assert.equal(signer.verify(token).ok, true);

        // Se simula la ventana del read-modify-write: el JSONL todavía no refleja
        // el consumo (otro proceso lo está por escribir / se truncó). El reclamo
        // atómico tiene que bloquear igual.
        fs.writeFileSync(nonceFile, '', 'utf8');
        assert.equal(signer.verify(token).reason, 'replayed',
            'el reclamo atómico debe bloquear aunque el JSONL no muestre el consumo');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#6206/A04: el reclamo atómico no rompe el camino feliz de tokens distintos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-token-claim-ok-'));
    try {
        const signer = actionToken.createTokenSigner({
            secret: SECRET, nonceFile: path.join(dir, 'nonces.jsonl'),
        });
        for (let i = 0; i < 5; i += 1) {
            const t = signer.sign({ issue: 6206 + i, action: 'approve' });
            assert.equal(signer.verify(t).ok, true, `token ${i} debería valer`);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#6206/A01: el aprobador de respaldo de `cua.operator_chat_ids` SÍ puede firmar', () => {
    // Misma unión que `delivery.resolveAuthorizedSigners:100`: el canal no puede
    // rechazar a quien la config designa y `delivery` acepta.
    const env = mkEnv({ deps: { config: { cua: { operator_chat_ids: ['77777777'] } } } });
    try {
        const res = submit(env, request(env), { signedBy: '77777777' });
        assert.equal(res.ok, true, `el respaldo designado por config debería firmar: ${res.reason}`);
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest.signed_by, '77777777');
    } finally { env.cleanup(); }
});

test('#6206/A01: la config NO ensancha la allowlist con quien no está designado', () => {
    const env = mkEnv({ deps: { config: { cua: { operator_chat_ids: ['77777777'] } } } });
    try {
        const res = submit(env, request(env), autoAutorizacion(env.dir, IMPOSTOR));
        assert.equal(res.ok, false);
        assert.match(res.reason, /no autorizado/i);
    } finally { env.cleanup(); }
});
