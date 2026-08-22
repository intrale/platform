// =============================================================================
// action-token.js — Tokens firmados HMAC para acciones rápidas de needs-human
// (issue #4068, split de #4050).
//
// Modelo de seguridad (CA-SEC-5, OWASP A04/A08 — anti-replay):
//   Un link de Telegram es una *capability portable y persistente*. Cada botón
//   de la alerta `needs-human` lleva un token firmado que autoriza UNA acción
//   sobre UN issue. El token:
//     - va firmado con HMAC-SHA256 (no falsificable sin el secreto),
//     - expira (`exp` corto, default 24h),
//     - es de UN SOLO USO (nonce persistido en `audit/human-block-tokens-used.jsonl`).
//   `verify()` rechaza: firma inválida/tampered, expirado, nonce ya consumido.
//
// El secreto NUNCA se hardcodea ni se loguea: se deriva del bot token de
// Telegram (fuente única `credentials.json` vía `lib/credentials.js`). Derivar
// con HMAC evita reusar el secreto crudo y desacopla el dominio del token.
//
// NOTA (#5458): `verify()` es 100% síncrono, así que dentro de un proceso no hay
// ventana de carrera. Pero el pipeline corre VARIOS procesos que verifican con el
// mismo store (dashboard, listener, y sus respawns), y ahí el patrón viejo
// "leer JSONL → appendFileSync" no probaba exclusión: dos procesos podían leer
// el nonce libre antes de que el otro appendeara. El consumo ahora es un claim
// exclusivo `open(..., 'wx')` (`O_CREAT|O_EXCL`) de un archivo por nonce: gana
// exactamente uno, el resto recibe `EEXIST` → `replayed`. Si el claim no se
// puede decidir (error de disco), se devuelve `unavailable` y NO se autoriza
// nada (fail-closed).
// =============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const trace = require('./traceability');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const DEFAULT_NONCE_FILE = path.join(PIPELINE_DIR, 'audit', 'human-block-tokens-used.jsonl');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h (SEC-5: exp corto)
const TOKEN_VERSION = 'v1';
const SECRET_INFO = 'human-block-action-token/v1';

// Allowlist cerrada de acciones (CA-SEC-3, OWASP A03). `pausar` queda FUERA por
// decisión de producto (PO #4068): no resuelve el bloqueo, solo lo congela.
//
// #4579 (gates de firma del operador): se agregan `approve`/`reject`/
// `adjust-definicion` — las tres acciones del canal de firma de un toque por
// Telegram. Se EXTIENDE la allowlist existente (no se reinventa la firma): el
// mismo `sign`/`verify` HMAC + nonce single-use cubre el anti-replay del botón.
//
// #5458 (capability del corte del fallback del vault): se agrega
// `vault-cut-fallback`. Esta allowlist es CRIPTOGRÁFICA — dice qué acciones se
// pueden firmar, NO qué acciones tocan el lifecycle. `vault-cut-fallback` es
// deliberadamente OPERACIONAL: queda fuera de `HUMAN_BLOCK_ACTIONS`, fuera de
// `isQuickAction()` y fuera de `GATE_ACTIONS` de `operator-gate.js`, así que
// ninguna ruta que la lleve puede llegar a `applyTransition()` ni mover
// work-files. El aislamiento lo cementan los tests de esos tres módulos.
const ACTION_ALLOWLIST = Object.freeze([
    'unblock', 'mas-contexto', 'devolver-definicion', 'priorizar',
    'approve', 'reject', 'adjust-definicion',
    'vault-cut-fallback',
]);

// #5458 — Acciones OPERACIONALES: no tocan lifecycle y su capability es mucho
// más peligrosa que un botón de gate (apaga el fallback de credenciales), así
// que llevan un TTL propio, corto y con MÁXIMO EXPLÍCITO verificado.
//
// El máximo no se aplica sólo al firmar (eso lo puede eludir cualquier caller
// que pase `exp` a mano): `verify()` lo REVALIDA usando el instante de emisión
// `t` que va DENTRO del cuerpo firmado. Un token operacional sin `t` —o con una
// vida mayor al cap— se rechaza cerrado. Como la acción es nueva, no existen
// tokens legacy sin `t`, así que exigirlo no rompe nada emitido antes.
const OPERATIONAL_TTL_MS = Object.freeze({
    'vault-cut-fallback': 10 * 60 * 1000, // 10 min: el operador confirma o caduca
});

/** TTL máximo permitido para `action`, o null si la acción no tiene cap. */
function maxTtlFor(action) {
    return Object.prototype.hasOwnProperty.call(OPERATIONAL_TTL_MS, action)
        ? OPERATIONAL_TTL_MS[action]
        : null;
}

/** ¿`action` es operacional (TTL capado + `t` obligatorio en el cuerpo)? */
function isOperationalAction(action) {
    return maxTtlFor(action) !== null;
}

// Los nonces se usan como NOMBRE DE ARCHIVO del claim atómico. `sign()` los
// genera con `crypto.randomBytes(12).toString('hex')` (24 hex), pero el nonce
// llega dentro de un cuerpo controlable por el atacante hasta que la firma se
// valida — y aun con firma válida no queremos construir paths con texto libre.
// Esta regex es la guarda anti path-traversal del store de claims.
const NONCE_RE = /^[a-f0-9]{8,64}$/;

// --- base64url helpers (sin padding, URL-safe para query strings) -----------
function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToString(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function deriveKey(rawSecret) {
    // Deriva una clave dedicada para no reusar el secreto crudo (telegram bot
    // token). HMAC-SHA256 actúa como KDF determinística.
    return crypto.createHmac('sha256', String(rawSecret)).update(SECRET_INFO).digest();
}

/**
 * Resuelve el secreto crudo desde la fuente única de credenciales. Lazy: solo
 * se invoca cuando no se inyecta un secreto explícito (tests inyectan el suyo).
 * @returns {string}
 * @throws si no hay secreto disponible (el caller debe degradar con gracia).
 */
function resolveRawSecret() {
    return require('./credentials').resolveVaultOnly('telegram.bot_token');
}

function isValidAction(action) {
    return ACTION_ALLOWLIST.includes(action);
}
function isValidIssue(issue) {
    return Number.isInteger(issue) && issue > 0 && issue <= 999999;
}

/**
 * Crea un firmador/verificador de tokens con secreto y store de nonces
 * inyectables (para tests herméticos).
 *
 * @param {object} opts
 * @param {string}   [opts.secret]    - secreto crudo. Default: resuelto de credentials.
 * @param {string}   [opts.nonceFile] - path del store JSONL de nonces usados.
 * @param {number}   [opts.ttlMs]     - vida del token (default 24h).
 * @param {function} [opts.now]       - clock injectable (default Date.now).
 */
function createTokenSigner(opts = {}) {
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const nonceFile = opts.nonceFile || DEFAULT_NONCE_FILE;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const rawSecret = opts.secret !== undefined ? opts.secret : resolveRawSecret();
    const key = deriveKey(rawSecret);

    function signBody(body) {
        return b64urlEncode(crypto.createHmac('sha256', key).update(body).digest());
    }

    // --- nonce store (un-solo-uso, atómico cross-process) -------------------
    //
    // #5458 — El patrón anterior (`readUsedNonces()` y después `appendFileSync`)
    // NO prueba exclusión mutua: dos PROCESOS (dashboard + listener, o dos
    // listeners tras un respawn) pueden leer el JSONL antes de que el otro
    // appendee y ambos ver el nonce libre. Con un botón que apaga el fallback de
    // credenciales, esa carrera es "dos confirmaciones → dos cortes".
    //
    // El claim ahora es un `open(..., 'wx')` sobre UN archivo por nonce:
    // `O_CREAT|O_EXCL` es atómico a nivel de filesystem (en Windows libuv lo
    // mapea a `CREATE_NEW`), así que exactamente un proceso gana y el resto
    // recibe `EEXIST`. El JSONL histórico se sigue leyendo (los nonces
    // consumidos ANTES de esta migración deben seguir muertos) y se sigue
    // appendeando después del claim, sólo como traza de auditoría.
    const claimDir = nonceFile + '.claims';

    function readUsedNonces() {
        const used = new Set();
        let raw;
        try { raw = fs.readFileSync(nonceFile, 'utf8'); } catch { return used; }
        for (const ln of raw.split('\n')) {
            if (!ln) continue;
            try {
                const o = JSON.parse(ln);
                if (o && o.n) used.add(String(o.n));
            } catch { /* línea corrupta — skip */ }
        }
        return used;
    }

    /** Traza de auditoría del consumo. Best-effort: nunca des-reclama el nonce. */
    function appendNonceAudit(nonce, meta) {
        try {
            fs.mkdirSync(path.dirname(nonceFile), { recursive: true });
            fs.appendFileSync(nonceFile, JSON.stringify({
                n: nonce,
                issue: meta && meta.issue,
                action: meta && meta.action,
                ts: new Date(now()).toISOString(),
            }) + '\n');
        } catch { /* la autoridad es el claim, no el JSONL */ }
    }

    // Retención del store de claims. Un claim pesa ~120 bytes y se crea UNA vez
    // por token consumido (un toque de botón del operador), así que el volumen
    // es bajo — pero `.pipeline/audit/` no tiene rotación y el disco lleno ya es
    // un modo de falla conocido de este repo. Se poda de forma OPORTUNISTA y
    // best-effort: una sola pasada por instancia, y sólo si el dir ya creció.
    //
    // Podar NO puede resucitar un token: `verify()` chequea la EXPIRACIÓN antes
    // del claim, y el corte de poda (7 días) es varias veces el TTL máximo que
    // emite este módulo (24h). Un token cuyo claim tiene más de 7 días ya se
    // rechaza como `expired` sin llegar nunca al nonce.
    const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
    const PRUNE_THRESHOLD = 500;
    let yaPodado = false;

    function podarClaimsViejos() {
        if (yaPodado) return;
        yaPodado = true;
        try {
            const nombres = fs.readdirSync(claimDir);
            if (nombres.length <= PRUNE_THRESHOLD) return;
            const limite = now() - PRUNE_AFTER_MS;
            for (const nombre of nombres) {
                const f = path.join(claimDir, nombre);
                try {
                    if (fs.statSync(f).mtimeMs < limite) fs.unlinkSync(f);
                } catch { /* archivo tomado por otro proceso — se ignora */ }
            }
        } catch { /* la poda NUNCA afecta la decisión del claim */ }
    }

    /**
     * Reclama el nonce de forma exclusiva y atómica (cross-process).
     * @returns {'claimed'|'replayed'|'unavailable'} — `unavailable` es
     *   fail-closed: no sabemos si el nonce estaba libre, así que NO se consume
     *   ni se autoriza nada.
     */
    function claimNonce(nonce, meta) {
        if (!NONCE_RE.test(nonce)) return 'unavailable'; // no apto como filename
        // 1. Nonces consumidos antes de la migración (JSONL histórico).
        if (readUsedNonces().has(nonce)) return 'replayed';
        // 2. Claim exclusivo — ésta es la autoridad. El `mkdir` va en su propio
        //    try: su `EEXIST` significa "el dir ya está", NO "el nonce ya se
        //    usó". Confundirlos convertiría un store roto en un `replayed`
        //    silencioso.
        try { fs.mkdirSync(claimDir, { recursive: true }); } catch { /* lo decide el open */ }
        let fd;
        try {
            fd = fs.openSync(path.join(claimDir, nonce + '.json'), 'wx');
        } catch (e) {
            if (e && e.code === 'EEXIST') return 'replayed';
            return 'unavailable';
        }
        try {
            fs.writeSync(fd, JSON.stringify({
                n: nonce,
                issue: meta && meta.issue,
                action: meta && meta.action,
                ts: new Date(now()).toISOString(),
            }));
        } catch { /* el claim vale aunque el cuerpo no se haya escrito */ }
        finally { try { fs.closeSync(fd); } catch { /* idempotente */ } }
        appendNonceAudit(nonce, meta);
        podarClaimsViejos();
        return 'claimed';
    }

    /**
     * Firma un token para {issue, action}. `exp` opcional (epoch ms); default
     * now()+ttlMs.
     * @returns {string} token `v1.<body>.<sig>`
     */
    function sign({ issue, action, exp } = {}) {
        const i = Number(issue);
        if (!isValidIssue(i)) throw new Error(`action-token.sign: issue inválido (${issue})`);
        if (!isValidAction(action)) throw new Error(`action-token.sign: action inválida (${action})`);
        // #5458 — `t` (instante de emisión) va DENTRO del cuerpo firmado para que
        // `verify()` pueda revalidar el TTL máximo de las acciones operacionales.
        // Es aditivo: los tokens legacy sin `t` siguen verificando igual.
        const issuedAt = now();
        const cap = maxTtlFor(action);
        // El cap se aplica también al `exp` explícito: un caller no puede pedir
        // una capability operacional de larga vida.
        let expiry = Number.isFinite(exp) ? exp : issuedAt + ttlMs;
        if (cap !== null) expiry = Math.min(expiry, issuedAt + cap);
        const payload = {
            i,
            a: action,
            n: crypto.randomBytes(12).toString('hex'),
            e: expiry,
            t: issuedAt,
        };
        const body = b64urlEncode(JSON.stringify(payload));
        return `${TOKEN_VERSION}.${body}.${signBody(body)}`;
    }

    /**
     * Verifica y CONSUME un token (un solo uso). Devuelve:
     *   { ok: true, issue, action, nonce } | { ok: false, reason: 'invalid'|'expired'|'replayed' }
     * El nonce se marca usado SOLO en el camino feliz. Se devuelve el `nonce`
     * consumido para que el caller (p.ej. el audit log de #4579) registre qué
     * capability se gastó, sin filtrar el token completo.
     */
    function verify(token) {
        if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
            return { ok: false, reason: 'invalid' };
        }
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
            return { ok: false, reason: 'invalid' };
        }
        const [, body, sig] = parts;
        // 1. Firma (timing-safe). Buffers de distinta longitud → invalid sin comparar.
        const expectedSig = signBody(body);
        const a = Buffer.from(sig);
        const b = Buffer.from(expectedSig);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return { ok: false, reason: 'invalid' };
        }
        // 2. Payload.
        let payload;
        try { payload = JSON.parse(b64urlDecodeToString(body)); }
        catch { return { ok: false, reason: 'invalid' }; }
        if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid' };
        const issue = Number(payload.i);
        const action = payload.a;
        const exp = Number(payload.e);
        const nonce = payload.n;
        if (!isValidIssue(issue) || !isValidAction(action) || !nonce || !Number.isFinite(exp)) {
            return { ok: false, reason: 'invalid' };
        }
        // 3. TTL máximo explícito de las acciones operacionales (#5458). Se
        //    revalida contra el instante de emisión FIRMADO: aunque alguien
        //    firmara con un `exp` largo, el token no se acepta. Sin `t` (o con
        //    `t` incoherente) se rechaza cerrado — la acción es nueva, no hay
        //    tokens legacy que proteger.
        const cap = maxTtlFor(action);
        if (cap !== null) {
            const issuedAt = Number(payload.t);
            if (!Number.isFinite(issuedAt) || exp - issuedAt > cap || exp <= issuedAt) {
                return { ok: false, reason: 'invalid' };
            }
        }
        // 4. Expiración (SEC-5).
        if (exp <= now()) return { ok: false, reason: 'expired' };
        // 5. Replay — nonce un solo uso, claim ATÓMICO cross-process (#5458).
        const claim = claimNonce(String(nonce), { issue, action });
        if (claim === 'replayed') return { ok: false, reason: 'replayed' };
        if (claim !== 'claimed') return { ok: false, reason: 'unavailable' };
        return { ok: true, issue, action, nonce: String(nonce), issuedAt: Number(payload.t) };
    }

    return { sign, verify, nonceFile, claimDir, ttlMs };
}

// --- singleton perezoso (producción) ----------------------------------------
let _default = null;
function getDefault() {
    if (!_default) _default = createTokenSigner();
    return _default;
}

module.exports = {
    createTokenSigner,
    // API de conveniencia que usa el secreto/store de producción.
    sign: (args) => getDefault().sign(args),
    verify: (token) => getDefault().verify(token),
    deriveKey,
    isValidAction,
    isValidIssue,
    // #5458 — cap de TTL de las acciones operacionales. Se exporta para que el
    // despachador operacional y los tests lean el MISMO valor, sin copiarlo.
    isOperationalAction,
    maxTtlFor,
    OPERATIONAL_TTL_MS,
    NONCE_RE,
    ACTION_ALLOWLIST,
    DEFAULT_TTL_MS,
    DEFAULT_NONCE_FILE,
    TOKEN_VERSION,
};
