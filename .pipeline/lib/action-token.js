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
// CONSUMO ÚNICO DEL NONCE — POR QUÉ NO ALCANZA EL SINGLE-THREAD
// -------------------------------------------------------------
// `verify()` es 100% síncrono, así que dentro de UN proceso el check de nonce y
// el append no tienen ventana de carrera (un doble-click no gasta el token dos
// veces). Pero la vieja nota de este módulo justificaba la seguridad del store
// con "corre en el proceso del dashboard (single-thread)", y ESA invariante ya
// no vale: desde #6206 el mismo `DEFAULT_NONCE_FILE` lo consumen DOS servicios
// separados — el listener de Telegram y el dashboard (`restart.js:93` y `:99`) —
// porque `approval-channel.js` despacha firmas desde ambos medios.
//
// Entre procesos, `readUsedNonces()` + `markNonceUsed()` es un read-modify-write
// sin lock: dos procesos leen "no usado" y ambos consumen el mismo token. Por eso
// el consumo se cierra con un RECLAMO ATÓMICO (`openSync(..., 'wx')` ⇒
// O_CREAT|O_EXCL): el kernel garantiza que exactamente uno gana. El JSONL se
// sigue escribiendo como registro histórico y para el camino legacy.
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
// #6206 — cada cuánto, como máximo, se barre `<nonceFile>.claims` (ver
// `pruneClaims`). El barrido es best-effort y no está en el camino de decisión.
const CLAIM_PRUNE_EVERY_MS = 60 * 60 * 1000; // 1h
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
// `vault-cut-fallback`. Esta allowlist es CRIPTOGRAFICA — dice que acciones se
// pueden firmar, NO que acciones tocan el lifecycle. `vault-cut-fallback` es
// deliberadamente OPERACIONAL: queda fuera de `HUMAN_BLOCK_ACTIONS`, fuera de
// `isQuickAction()` y fuera de `GATE_ACTIONS` de `operator-gate.js`, asi que
// ninguna ruta que la lleve puede llegar a `applyTransition()` ni mover
// work-files. El aislamiento lo cementan los tests de esos tres modulos.
const ACTION_ALLOWLIST = Object.freeze([
    'unblock', 'mas-contexto', 'devolver-definicion', 'priorizar',
    'approve', 'reject', 'adjust-definicion',
    'vault-cut-fallback',
]);

// #5458 — Acciones OPERACIONALES: no tocan lifecycle y su capability es mucho
// mas peligrosa que un boton de gate (apaga el fallback de credenciales), asi
// que llevan un TTL propio, corto y con MAXIMO EXPLICITO verificado.
//
// El maximo no se aplica solo al firmar (eso lo puede eludir cualquier caller
// que pase `exp` a mano): `verify()` lo REVALIDA usando el instante de emision
// `t` que va DENTRO del cuerpo firmado. Un token operacional sin `t` —o con una
// vida mayor al cap— se rechaza cerrado. Como la accion es nueva, no existen
// tokens legacy sin `t`, asi que exigirlo no rompe nada emitido antes.
const OPERATIONAL_TTL_MS = Object.freeze({
    'vault-cut-fallback': 10 * 60 * 1000, // 10 min: el operador confirma o caduca
});

/** TTL maximo permitido para `action`, o null si la accion no tiene cap. */
function maxTtlFor(action) {
    return Object.prototype.hasOwnProperty.call(OPERATIONAL_TTL_MS, action)
        ? OPERATIONAL_TTL_MS[action]
        : null;
}

/** Es `action` operacional (TTL capado + `t` obligatorio en el cuerpo)? */
function isOperationalAction(action) {
    return maxTtlFor(action) !== null;
}

// #5458 — Guarda de FORMA del nonce. En este modulo el nonce nunca se usa crudo
// como nombre de archivo (el reclamo hashea el valor, ver `claimPathFor`), pero
// el nonce llega dentro de un cuerpo controlable por el atacante hasta que la
// firma se valida: validar la forma mantiene inerte cualquier derivacion futura.
const NONCE_RE = /^[a-f0-9]{8,64}$/;

// --- #6206 · binding (gate, issue, anchor) dentro del payload firmado --------
//
// El canal único de firma (`approval-channel.js`) necesita que un token diga
// SOBRE QUÉ está firmando, no sólo qué acción autoriza. Hoy conviven dos
// productores (`human-block.js`, `operator-gate.js`) que mintean con la misma
// clave derivada y la misma forma `{i,a,n,e}`: sin binding, el botón de un gate
// puede firmar otro (R-1 del issue, OWASP A01/A08).
//
// Se agregan DOS campos OPCIONALES al payload:
//   `g` — gate al que el token queda atado (string corto de un enum del caller).
//   `h` — ancla de lo firmado, serializada `<kind>|<value>` (ver `serializeAnchor`).
//
// Decisión D-3 del issue: el binding viaja DENTRO del payload firmado y se
// compara en el consumo. La clave compuesta del store (`k`) es CONSECUENCIA de
// ese binding, nunca el mecanismo: namespacear sólo el store convertiría el
// un-solo-uso en "un uso por store".
//
// Retro-compatibilidad (R-2): `g`/`h` NO entran en la guarda de campos de
// `verify()`; los dos consumidores vivos (`human-block-action-handler.js:174`,
// `operator-gate.js:341`) siguen funcionando con tokens sin esos campos.
const GATE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ANCHOR_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const NONCE_NS_INFO = 'action-token/ns/v1';

/**
 * ¿`gate` es un identificador de gate con forma segura? El enum concreto lo
 * define el caller (`approval-channel.GATES`); acá sólo se valida la FORMA para
 * que el valor sea inerte como componente de una clave derivada.
 * @param {string} gate
 * @returns {boolean}
 */
function isValidGate(gate) {
    return typeof gate === 'string' && GATE_RE.test(gate);
}

/**
 * Serializa un ancla `{kind, value}` a la forma canónica `<kind>|<value>` que
 * viaja en `h`.
 *
 * El `kind` va SIEMPRE adentro y se valida contra `ANCHOR_KIND_RE` (que excluye
 * el separador `|`), así que la serialización es inyectiva: un `body-hash` y un
 * `commit-sha` con el mismo `value` producen anclas DISTINTAS y no son
 * intercambiables (R2 del issue — prohibido normalizar ambos tipos a uno solo).
 *
 * Acepta también un string ya serializado (idempotente) para que el caller pueda
 * pasar el valor que le devolvió esta misma función.
 *
 * @param {{kind:string, value:string}|string} anchor
 * @returns {string|null} `null` si el ancla es inválida (fail-closed).
 */
function serializeAnchor(anchor) {
    if (typeof anchor === 'string') {
        // Ya serializada: debe respetar la forma `<kind>|<value>`.
        const idx = anchor.indexOf('|');
        if (idx <= 0 || idx === anchor.length - 1) return null;
        return ANCHOR_KIND_RE.test(anchor.slice(0, idx)) ? anchor : null;
    }
    if (!anchor || typeof anchor !== 'object') return null;
    const kind = String(anchor.kind == null ? '' : anchor.kind);
    const value = String(anchor.value == null ? '' : anchor.value);
    if (!ANCHOR_KIND_RE.test(kind) || value === '' || value.length > 512) return null;
    return `${kind}|${value}`;
}

/**
 * Clave compuesta del store de nonces, derivada del binding `(g, i, h, n)`.
 * Es CONSECUENCIA del binding firmado, no un sustituto (D-3).
 * @returns {string} hex sha256
 */
function nonceKey({ g, i, h, n }) {
    return crypto.createHash('sha256')
        .update(`${NONCE_NS_INFO}|${g}|${i}|${h}|${n}`, 'utf8')
        .digest('hex');
}

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
 * @param {function} [opts.nonceGen]  - #6206: generador de nonce injectable.
 *   SÓLO para tests que necesitan dos tokens con el mismo `n` y distinto
 *   binding (replay cross-namespace). Producción NUNCA lo pasa: el default es
 *   `crypto.randomBytes`. Se inyecta la FUENTE de aleatoriedad en vez de
 *   aceptar un `nonce` explícito en `sign()`, que sería un footgun de reuso.
 */
function createTokenSigner(opts = {}) {
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const nonceFile = opts.nonceFile || DEFAULT_NONCE_FILE;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const nonceGen = typeof opts.nonceGen === 'function'
        ? () => String(opts.nonceGen())
        : () => crypto.randomBytes(12).toString('hex');
    const rawSecret = opts.secret !== undefined ? opts.secret : resolveRawSecret();
    const key = deriveKey(rawSecret);

    function signBody(body) {
        return b64urlEncode(crypto.createHmac('sha256', key).update(body).digest());
    }

    // --- nonce store (un-solo-uso) ------------------------------------------
    //
    // #6206 — se leen DOS sets del mismo JSONL:
    //   `plain`     — nonces crudos (`n`). Cubre TODO token consumido, con o sin
    //                 binding, y es el que usa el camino legacy sin cambios.
    //   `composite` — claves compuestas (`k`) de los tokens con binding.
    // El camino del canal exige que NINGUNO de los dos matchee (estrictamente
    // más seguro que chequear sólo `k`: un mismo nonce no se puede reusar
    // cambiando de namespace).
    function readUsedNonces() {
        const plain = new Set();
        const composite = new Set();
        let raw;
        try {
            raw = fs.readFileSync(nonceFile, 'utf8');
        } catch (e) {
            // FAIL-CLOSED. Sólo "el archivo todavía no existe" significa
            // legítimamente "ningún nonce usado". Cualquier otro error
            // (EBUSY/EACCES/EPERM/EISDIR/EMFILE…) es "no sé qué se consumió", y
            // tratarlo como set vacío revalida tokens YA GASTADOS: con el store
            // ilegible un token consumido volvía a valer. Se relanza para que el
            // caller rechace; los tres consumidores vivos ya envuelven `verify()`
            // (`human-block-action-handler.js:174`, `listener-telegram.js:876`,
            // `approval-channel.submitSignature`), así que no mata ningún proceso.
            if (e && e.code === 'ENOENT') return { plain, composite };
            throw e;
        }
        for (const ln of raw.split('\n')) {
            if (!ln) continue;
            try {
                const o = JSON.parse(ln);
                if (o && o.n) plain.add(String(o.n));
                if (o && o.k) composite.add(String(o.k));
            } catch { /* línea corrupta — skip */ }
        }
        return { plain, composite };
    }
    // --- reclamo atómico del nonce (#6206) -----------------------------------
    //
    // El directorio de reclamos vive junto al JSONL (bajo `.pipeline/audit/`, que
    // ya está gitignored). Un reclamo es un archivo vacío cuyo nombre es el hash
    // del valor reclamado: nunca se escribe el nonce crudo en un nombre de path.
    const claimDir = `${nonceFile}.claims`;
    const claimPruneMarker = path.join(claimDir, '.last-prune');

    function claimPathFor(value) {
        const h = crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
        return path.join(claimDir, `${h.slice(0, 40)}.claim`);
    }

    /**
     * Cuerpo del reclamo (#5458): metadata del consumo, nunca el token ni la
     * firma. El nombre del archivo ya es un hash, asi que el cuerpo es lo unico
     * que hace auditable un reclamo suelto.
     */
    function claimBody(meta) {
        return JSON.stringify({
            n: meta && meta.nonce,
            issue: meta && meta.issue,
            action: meta && meta.action,
            ts: new Date(now()).toISOString(),
        });
    }

    /**
     * #6206 (REQ-SEC-6206-12 / REQ-GURU-6206-D) — poda del directorio de
     * reclamos por ANTIGÜEDAD.
     *
     * El directorio crecía un archivo por token consumido y no se podaba nunca.
     * No era explotable (sólo un token con HMAC válido y no expirado crea
     * reclamo), pero crecía sin techo.
     *
     * POR QUÉ ES SEGURO PODAR: el reclamo `wx` sólo cierra la ventana de carrera
     * ENTRE PROCESOS entre la lectura del JSONL y su append. La autoridad
     * histórica del un-solo-uso es el JSONL (`readUsedNonces`), que NO se poda:
     * un nonce consumido sigue bloqueado por `used.plain` aunque su reclamo ya
     * no exista. Y un token cuyo reclamo tiene más de `ttlMs` está expirado, así
     * que `verify()` ya lo rechazó en el paso 3 antes de llegar acá.
     *
     * Throttle por marcador en disco (no por reloj de proceso ni azar): la poda
     * corre a lo sumo una vez por `CLAIM_PRUNE_EVERY_MS`, así el camino caliente
     * no paga un `readdirSync` por firma.
     */
    function pruneClaims() {
        const nowMs = Number(now());
        try {
            const st = fs.statSync(claimPruneMarker);
            if (nowMs - Number(st.mtimeMs) < CLAIM_PRUNE_EVERY_MS) return;
        } catch { /* sin marcador ⇒ primera poda */ }

        // El marcador se toca ANTES de barrer: si el barrido falla a mitad, no
        // se reintenta en cada firma.
        try { fs.writeFileSync(claimPruneMarker, String(nowMs), 'utf8'); } catch { return; }

        let names;
        try { names = fs.readdirSync(claimDir); } catch { return; }
        for (const name of names) {
            if (!name.endsWith('.claim')) continue;
            const full = path.join(claimDir, name);
            try {
                const st = fs.statSync(full);
                if (nowMs - Number(st.mtimeMs) > ttlMs) fs.unlinkSync(full);
            } catch { /* best-effort: la poda nunca puede romper el consumo */ }
        }
    }

    /**
     * Reclama atómicamente TODOS los valores o ninguno. `openSync(..., 'wx')` es
     * O_CREAT|O_EXCL: entre procesos concurrentes exactamente uno crea el archivo
     * y el resto recibe EEXIST. Eso cierra la ventana del read-modify-write.
     *
     * Fail-closed en dos direcciones:
     *   - EEXIST            ⇒ ese valor ya fue consumido ⇒ `replayed`.
     *   - cualquier otro    ⇒ no podemos GARANTIZAR unicidad ⇒ `unavailable`
     *                         (no se consume ni se firma).
     *
     * @returns {{claimed:true}|{claimed:false, reason:'replayed'|'unavailable'}}
     */
    function claimNonces(values, meta) {
        try {
            fs.mkdirSync(claimDir, { recursive: true });
        } catch {
            return { claimed: false, reason: 'unavailable' };
        }
        pruneClaims();
        const won = [];
        const body = claimBody(meta);
        for (const value of values) {
            const target = claimPathFor(value);
            try {
                const fd = fs.openSync(target, 'wx');
                // El reclamo vale por existir; el cuerpo es traza de auditoria.
                try { fs.writeSync(fd, body); } catch { /* best-effort */ }
                finally { try { fs.closeSync(fd); } catch { /* idempotente */ } }
                won.push(target);
            } catch (e) {
                // Rollback de los reclamos que SÍ ganamos en este intento: el
                // token no se consume, así que no debe quedar medio quemado.
                for (const w of won) { try { fs.unlinkSync(w); } catch { /* best-effort */ } }
                return { claimed: false, reason: e && e.code === 'EEXIST' ? 'replayed' : 'unavailable' };
            }
        }
        return { claimed: true };
    }

    function markNonceUsed(nonce, meta) {
        try { fs.mkdirSync(path.dirname(nonceFile), { recursive: true }); } catch { /* idempotente */ }
        const rec = {
            n: nonce,
            issue: meta && meta.issue,
            action: meta && meta.action,
            ts: new Date(now()).toISOString(),
        };
        // `n` se escribe SIEMPRE (R-2: el set legacy sigue cubriendo todo token
        // consumido). `k` se agrega sólo cuando el token trae binding.
        if (meta && meta.k) rec.k = String(meta.k);
        if (meta && meta.gate) rec.gate = String(meta.gate);
        fs.appendFileSync(nonceFile, JSON.stringify(rec) + '\n');
    }

    /**
     * Firma un token para {issue, action}. `exp` opcional (epoch ms); default
     * now()+ttlMs.
     *
     * #6206 — `gate` y `anchor` son OPCIONALES y atan el token a un contexto
     * concreto (`g`/`h` en el payload). Los emite `approval-channel.js`, que en
     * el consumo los exige; el camino legacy de botones sigue firmando sin
     * ellos y no cambia de forma.
     *
     * @param {object}   p
     * @param {number}   p.issue
     * @param {string}   p.action   - ∈ ACTION_ALLOWLIST.
     * @param {number}   [p.exp]    - epoch ms.
     * @param {string}   [p.gate]   - gate al que se ata el token (forma `GATE_RE`).
     * @param {{kind:string,value:string}|string} [p.anchor] - ancla de lo firmado.
     * @returns {string} token `v1.<body>.<sig>`
     */
    function sign({ issue, action, exp, gate, anchor } = {}) {
        const i = Number(issue);
        if (!isValidIssue(i)) throw new Error(`action-token.sign: issue inválido (${issue})`);
        if (!isValidAction(action)) throw new Error(`action-token.sign: action inválida (${action})`);
        // #5458 — `t` (instante de emision) va DENTRO del cuerpo firmado para que
        // `verify()` pueda revalidar el TTL maximo de las acciones operacionales.
        // Es aditivo: los tokens legacy sin `t` siguen verificando igual.
        const issuedAt = now();
        const cap = maxTtlFor(action);
        // El cap se aplica tambien al `exp` explicito: un caller no puede pedir
        // una capability operacional de larga vida.
        let expiry = Number.isFinite(exp) ? exp : issuedAt + ttlMs;
        if (cap !== null) expiry = Math.min(expiry, issuedAt + cap);
        const payload = {
            i,
            a: action,
            n: nonceGen(),
            e: expiry,
            t: issuedAt,
        };
        // Binding opcional. Fail-closed: si el caller PIDE binding y el valor es
        // inválido, se rompe acá — nunca se emite un token con binding a medias
        // (un token con `g` pero sin `h` sería aceptable para un consumidor
        // distraído y no ataría el ancla).
        if (gate !== undefined || anchor !== undefined) {
            if (!isValidGate(gate)) {
                throw new Error(`action-token.sign: gate inválido (${gate})`);
            }
            const h = serializeAnchor(anchor);
            if (h === null) {
                throw new Error('action-token.sign: anchor inválida (esperado {kind, value})');
            }
            payload.g = gate;
            payload.h = h;
        }
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
        // 3. #5458 — TTL maximo explicito de las acciones operacionales. Se
        //    revalida contra el instante de emision FIRMADO: aunque alguien
        //    firmara con un `exp` largo, el token no se acepta. Sin `t` (o con
        //    `t` incoherente) se rechaza cerrado — la accion es nueva, no hay
        //    tokens legacy que proteger.
        const capMs = maxTtlFor(action);
        if (capMs !== null) {
            const issuedAt = Number(payload.t);
            if (!Number.isFinite(issuedAt) || exp - issuedAt > capMs || exp <= issuedAt) {
                return { ok: false, reason: 'invalid' };
            }
        }
        // 4. Expiración (SEC-5).
        if (exp <= now()) return { ok: false, reason: 'expired' };

        // #6206 — binding opcional. `g`/`h` quedan DELIBERADAMENTE fuera de la
        // guarda de campos de arriba (R-2): un token viejo sin ellos sigue
        // siendo válido acá. La obligatoriedad vive en `approval-channel`, no en
        // este verificador compartido.
        const g = typeof payload.g === 'string' && isValidGate(payload.g) ? payload.g : null;
        const h = typeof payload.h === 'string' ? serializeAnchor(payload.h) : null;
        const bound = g !== null && h !== null;
        const k = bound ? nonceKey({ g, i: issue, h, n: String(nonce) }) : null;

        // 5. Replay — nonce un solo uso (SEC-5).
        const used = readUsedNonces();
        // El nonce crudo bloquea SIEMPRE (cubre legacy y cross-namespace: un
        // token consumido en un namespace no revalida en otro). La clave
        // compuesta agrega el bloqueo específico del binding.
        if (used.plain.has(String(nonce))) return { ok: false, reason: 'replayed' };
        if (bound && used.composite.has(k)) return { ok: false, reason: 'replayed' };

        // 6. #6206 — RECLAMO ATÓMICO. El chequeo de arriba lee el histórico (cubre
        //    lo consumido antes de que existieran los reclamos y el camino
        //    legacy), pero entre esa lectura y el append hay una ventana que dos
        //    PROCESOS distintos pueden atravesar a la vez. `wx` la cierra: el
        //    kernel decide el ganador. Se reclaman los mismos dos espacios de
        //    nombres que se chequean arriba, para que el bloqueo sea simétrico.
        const claim = claimNonces(
            bound ? [String(nonce), `k:${k}`] : [String(nonce)],
            { nonce: String(nonce), issue, action },
        );
        if (!claim.claimed) return { ok: false, reason: claim.reason };

        markNonceUsed(String(nonce), { issue, action, k, gate: g });
        // `issuedAt` (#5459) — el corte de vault necesita la edad real de la
        // autorizacion para decidir el fallback; se expone junto al veredicto
        // para no releer el payload aguas arriba.
        const res = { ok: true, issue, action, nonce: String(nonce), issuedAt: Number(payload.t) };
        if (bound) { res.g = g; res.h = h; res.k = k; }
        return res;
    }

    return { sign, verify, nonceFile, claimDir, ttlMs, pruneClaims };
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
    // #6206 — binding (gate, issue, anchor). Superficie NUEVA; `ACTION_ALLOWLIST`
    // y `DEFAULT_NONCE_FILE` quedan intactos.
    isValidGate,
    serializeAnchor,
    nonceKey,
    // #5458 — cap de TTL de las acciones operacionales. Se exporta para que el
    // despachador operacional y los tests lean el MISMO valor, sin copiarlo.
    isOperationalAction,
    maxTtlFor,
    OPERATIONAL_TTL_MS,
    NONCE_RE,
    ACTION_ALLOWLIST,
    DEFAULT_TTL_MS,
    CLAIM_PRUNE_EVERY_MS,
    DEFAULT_NONCE_FILE,
    TOKEN_VERSION,
};
