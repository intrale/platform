// =============================================================================
// action-token-vault-cut-5458.test.js — Capability criptográfica de
// `vault-cut-fallback` (issue #5458, split de #5452).
//
// Cubre los CA del split que viven en `action-token.js`:
//   - la acción se puede FIRMAR (allowlist criptográfica) …
//   - … con expiración CORTA y máximo explícito REVALIDADO en `verify()`
//   - nonce de un solo uso con consumo ATÓMICO CROSS-PROCESS: dos callbacks
//     concurrentes (procesos separados de verdad, no dos llamadas sincrónicas)
//     permiten como máximo un consumo exitoso
//   - HMAC inválido, expiración, replay y acción alterada fallan CERRADO y sin
//     exponer datos sensibles (aserciones negativas con canarios falsos)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createTokenSigner,
    ACTION_ALLOWLIST,
    isValidAction,
    isOperationalAction,
    maxTtlFor,
    OPERATIONAL_TTL_MS,
} = require('../action-token');

const ACTION = 'vault-cut-fallback';
// Canario: si aparece en un toast/resultado, algo está filtrando el secreto.
const SECRET = 'CANARIO-SECRETO-5458-NO-REAL';

function tmpNonceFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actoken-5458-'));
    return path.join(dir, 'used.jsonl');
}

// --- allowlist criptográfica -------------------------------------------------

test('#5458 `vault-cut-fallback` está en la allowlist criptográfica y es operacional', () => {
    assert.ok(ACTION_ALLOWLIST.includes(ACTION));
    assert.equal(isValidAction(ACTION), true);
    assert.equal(isOperationalAction(ACTION), true);
    // Las acciones de gate/needs-human NO son operacionales: no llevan cap.
    for (const otra of ['approve', 'reject', 'adjust-definicion', 'unblock']) {
        assert.equal(isOperationalAction(otra), false, `${otra} no debería ser operacional`);
        assert.equal(maxTtlFor(otra), null);
    }
});

test('#5458 sign/verify aceptan la acción y devuelven el binding firmado', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    const token = t.sign({ issue: 5458, action: ACTION });
    const r = t.verify(token);
    assert.equal(r.ok, true);
    assert.equal(r.action, ACTION);
    assert.equal(r.issue, 5458);
    assert.ok(typeof r.nonce === 'string' && r.nonce.length > 0);
});

// --- expiración corta con máximo explícito -----------------------------------

test('#5458 el TTL efectivo se capa al máximo operacional aunque el signer pida 24h', () => {
    let ahora = 1_000_000;
    const t = createTokenSigner({
        secret: SECRET, nonceFile: tmpNonceFile(),
        ttlMs: 24 * 60 * 60 * 1000, // el default largo del canal de firma
        now: () => ahora,
    });
    const token = t.sign({ issue: 5458, action: ACTION });
    const body = JSON.parse(Buffer.from(
        token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    assert.equal(body.e - body.t, OPERATIONAL_TTL_MS[ACTION]);
    assert.ok(OPERATIONAL_TTL_MS[ACTION] <= 15 * 60 * 1000, 'el cap debe ser corto');

    // Justo antes de vencer: vale. Un ms después del cap: expirado.
    ahora += OPERATIONAL_TTL_MS[ACTION] - 1;
    assert.equal(t.verify(token).ok, true);
});

test('#5458 un `exp` explícito y largo NO extiende la capability operacional', () => {
    const ahora = 2_000_000;
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile(), now: () => ahora });
    const token = t.sign({ issue: 5458, action: ACTION, exp: ahora + 90 * 24 * 60 * 60 * 1000 });
    const body = JSON.parse(Buffer.from(
        token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    assert.equal(body.e - body.t, OPERATIONAL_TTL_MS[ACTION]);
});

test('#5458 verify REVALIDA el cap: un token con vida mayor al máximo se rechaza', () => {
    // Se firma "a mano" con la misma clave derivada para simular un emisor que
    // eludió el cap del `sign()` (bug futuro, caller hostil o token viejo).
    const crypto = require('crypto');
    const { deriveKey } = require('../action-token');
    const key = deriveKey(SECRET);
    const ahora = 3_000_000;
    const payload = {
        i: 5458, a: ACTION, n: crypto.randomBytes(12).toString('hex'),
        e: ahora + 24 * 60 * 60 * 1000, // 24h — muy por encima del cap
        t: ahora,
    };
    const b64 = (buf) => Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const body = b64(JSON.stringify(payload));
    const sig = b64(crypto.createHmac('sha256', key).update(body).digest());
    const token = `v1.${body}.${sig}`;

    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile(), now: () => ahora });
    const r = t.verify(token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
});

test('#5458 un token operacional SIN instante de emisión firmado falla cerrado', () => {
    const crypto = require('crypto');
    const { deriveKey } = require('../action-token');
    const key = deriveKey(SECRET);
    const ahora = 4_000_000;
    const payload = { i: 5458, a: ACTION, n: crypto.randomBytes(12).toString('hex'), e: ahora + 60_000 };
    const b64 = (buf) => Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const body = b64(JSON.stringify(payload));
    const token = `v1.${body}.${b64(crypto.createHmac('sha256', key).update(body).digest())}`;

    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile(), now: () => ahora });
    assert.equal(t.verify(token).ok, false);
});

test('#5458 token expirado se rechaza como `expired` sin consumir el nonce', () => {
    let ahora = 5_000_000;
    const file = tmpNonceFile();
    const t = createTokenSigner({ secret: SECRET, nonceFile: file, now: () => ahora });
    const token = t.sign({ issue: 5458, action: ACTION });
    ahora += OPERATIONAL_TTL_MS[ACTION] + 1;
    const r = t.verify(token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
    // Fail-closed no significa "gastar la capability": no se creó ningún claim.
    assert.equal(fs.existsSync(`${file}.claims`), false);
});

// --- HMAC inválido / acción alterada -----------------------------------------

test('#5458 HMAC inválido y acción alterada fallan cerrado sin filtrar el secreto', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    const token = t.sign({ issue: 5458, action: ACTION });

    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
    const r1 = t.verify(tampered);
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'invalid');

    // Acción alterada en el cuerpo (sin re-firmar) → firma no cuadra.
    const [ver, body, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(
        body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    payload.a = 'approve'; // escalada a una acción de gate
    const nuevoBody = Buffer.from(JSON.stringify(payload)).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r2 = t.verify(`${ver}.${nuevoBody}.${sig}`);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'invalid');

    // Aserción negativa: ningún resultado menciona el secreto.
    for (const r of [r1, r2]) {
        assert.doesNotMatch(JSON.stringify(r), /CANARIO-SECRETO/);
    }
});

// --- nonce de un uso ---------------------------------------------------------

test('#5458 replay in-process: el segundo verify devuelve `replayed`', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    const token = t.sign({ issue: 5458, action: ACTION });
    assert.equal(t.verify(token).ok, true);
    const r = t.verify(token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'replayed');
});

test('#5458 un nonce consumido en el JSONL legacy sigue muerto tras la migración', () => {
    const file = tmpNonceFile();
    const t = createTokenSigner({ secret: SECRET, nonceFile: file });
    const token = t.sign({ issue: 5458, action: ACTION });
    const payload = JSON.parse(Buffer.from(
        token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    // Store viejo: sólo la línea del JSONL, sin claim file.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ n: payload.n, issue: 5458, action: ACTION })}\n`);
    assert.equal(t.verify(token).reason, 'replayed');
});

// --- CONCURRENCIA CROSS-PROCESS (el CA central del split) --------------------

test('#5458 dos callbacks CONCURRENTES en procesos distintos: como máximo un consumo', () => {
    const file = tmpNonceFile();
    const t = createTokenSigner({ secret: SECRET, nonceFile: file });
    const token = t.sign({ issue: 5458, action: ACTION });

    // Cada hijo es un PROCESO node real: el patrón viejo (leer JSONL → append)
    // dejaba que los N leyeran "libre" antes de que ninguno escribiera. El claim
    // `open(..., 'wx')` hace que gane exactamente uno.
    const runner = path.join(os.tmpdir(), `cut-5458-runner-${process.pid}.js`);
    fs.writeFileSync(runner, `
        const { createTokenSigner } = require(${JSON.stringify(path.resolve(__dirname, '..', 'action-token.js'))});
        const t = createTokenSigner({ secret: ${JSON.stringify(SECRET)}, nonceFile: ${JSON.stringify(file)} });
        // Barrera de arranque: todos los hijos esperan al mismo instante de pared
        // para maximizar el solapamiento del claim.
        const arranque = Number(process.argv[3]);
        while (Date.now() < arranque) { /* spin */ }
        const r = t.verify(process.argv[2]);
        process.stdout.write(JSON.stringify(r));
    `, 'utf8');

    {
        const arranque = Date.now() + 400;
        const hijos = [0, 1, 2, 3].map(() => {
            const child = spawn(process.execPath, [runner, token, String(arranque)], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            child.stdout.on('data', (c) => { out += c; });
            return new Promise((res) => child.on('close', () => res(out)));
        });

        return Promise.all(hijos).then((salidas) => {
            const resultados = salidas.map((s) => {
                try { return JSON.parse(s); } catch { return { ok: false, reason: 'crash', raw: s }; }
            });
            const exitosos = resultados.filter((r) => r.ok === true);
            assert.equal(exitosos.length, 1,
                `esperaba exactamente 1 consumo exitoso, hubo ${exitosos.length}: ${JSON.stringify(resultados)}`);
            // El resto NO puede haber ejecutado nada: `replayed` (perdió el claim).
            for (const r of resultados.filter((x) => x.ok !== true)) {
                assert.equal(r.reason, 'replayed', `reason inesperada: ${JSON.stringify(r)}`);
            }
        }).finally(() => {
            // El borrado va DENTRO de la cadena: un `finally` sincrónico borraría
            // el runner antes de que los hijos alcancen a cargarlo.
            try { fs.unlinkSync(runner); } catch { /* best-effort */ }
        });
    }
});

test('#5458 el claim atómico es un archivo por nonce dentro del store derivado', () => {
    const file = tmpNonceFile();
    const t = createTokenSigner({ secret: SECRET, nonceFile: file });
    assert.equal(t.claimDir, `${file}.claims`);
    const token = t.sign({ issue: 5458, action: ACTION });
    const r = t.verify(token);
    assert.equal(r.ok, true);
    // #6206 unificó el store: el nombre del reclamo es el hash del valor
    // reclamado (nunca el nonce crudo en un path) y lleva sufijo `.claim`. Un
    // token SIN binding sigue reclamando exactamente un valor.
    const claims = fs.readdirSync(t.claimDir).filter((n) => n.endsWith('.claim'));
    assert.equal(claims.length, 1);
    assert.doesNotMatch(claims[0], new RegExp(r.nonce), 'el nonce crudo no va en el path');
    // El claim no guarda el token ni la firma — sólo metadata del consumo.
    const guardado = JSON.parse(fs.readFileSync(path.join(t.claimDir, claims[0]), 'utf8'));
    assert.equal(guardado.action, ACTION);
    assert.equal(guardado.issue, 5458);
    assert.equal(guardado.n, r.nonce);
    assert.doesNotMatch(JSON.stringify(guardado), /CANARIO-SECRETO/);
    assert.equal(guardado.token, undefined);
    assert.equal(guardado.sig, undefined);
});

test('#5458 si el claim no se puede decidir, verify devuelve `unavailable` (fail-closed)', () => {
    const file = tmpNonceFile();
    const t = createTokenSigner({ secret: SECRET, nonceFile: file });
    const token = t.sign({ issue: 5458, action: ACTION });
    // Se ocupa el path del store de claims con un ARCHIVO: `mkdirSync` sobre él
    // falla con ENOTDIR/EEXIST-no-dir → no se puede reclamar → fail-closed.
    fs.writeFileSync(`${file}.claims`, 'no soy un directorio');
    const r = t.verify(token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unavailable');
});

// --- retención del store de claims -------------------------------------------

test('#5458 la poda del store de claims no puede resucitar un token vivo', () => {
    const file = tmpNonceFile();
    let ahora = 10_000_000_000;
    const t = createTokenSigner({ secret: SECRET, nonceFile: file, now: () => ahora });
    const token = t.sign({ issue: 5458, action: ACTION });
    assert.equal(t.verify(token).ok, true);

    // Se fuerza la poda: reclamos y marcador de throttle envejecidos más allá
    // de sus umbrales (#6206 poda por ANTIGÜEDAD > ttlMs, throttleada por el
    // marcador en disco, no por un umbral de cantidad).
    const claims = `${file}.claims`;
    const viejo = ahora - 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i += 1) {
        const f = path.join(claims, `relleno${i}.claim`);
        fs.writeFileSync(f, '{}');
        fs.utimesSync(f, new Date(viejo), new Date(viejo));
    }
    for (const f of fs.readdirSync(claims)) {
        const full = path.join(claims, f);
        fs.utimesSync(full, new Date(viejo), new Date(viejo));
    }
    const antes = fs.readdirSync(claims).filter((n) => n.endsWith('.claim')).length;

    const t2 = createTokenSigner({ secret: SECRET, nonceFile: file, now: () => ahora });
    assert.equal(t2.verify(t2.sign({ issue: 1, action: ACTION })).ok, true);
    assert.ok(fs.readdirSync(claims).filter((n) => n.endsWith('.claim')).length < antes,
        'la poda debe haber corrido');

    // El token original quedó SIN claim, pero sigue muerto: ya expiró (el corte
    // de poda es muy superior al TTL) y además su nonce vive en el JSONL.
    const r = t.verify(token);
    assert.equal(r.ok, false);
    assert.ok(['expired', 'replayed'].includes(r.reason), `reason inesperada: ${r.reason}`);
});

test('#5458 con pocos claims la poda no borra nada', () => {
    const file = tmpNonceFile();
    const t = createTokenSigner({ secret: SECRET, nonceFile: file });
    for (let i = 1; i <= 5; i += 1) {
        assert.equal(t.verify(t.sign({ issue: i, action: ACTION })).ok, true);
    }
    assert.equal(
        fs.readdirSync(`${file}.claims`).filter((n) => n.endsWith('.claim')).length,
        5,
    );
});
