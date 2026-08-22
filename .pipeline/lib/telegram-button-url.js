// =============================================================================
// telegram-button-url.js — Punto ÚNICO de decisión sobre si un botón inline de
// Telegram puede emitirse como `url` (issue #5923).
//
// Problema que resuelve
// ---------------------
// La Bot API de Telegram RECHAZA los botones `url` que apuntan a hosts no
// públicos (`http://localhost:3200/?action=...`). Esos salientes nunca pueden
// prosperar: agotan los 5 reintentos y terminan en `servicios/telegram/fallido/`
// + alerta. La alerta al operador simplemente NUNCA llega.
//
// La causa raíz NO es "la URL es localhost": es que el botón se emite como
// `url`, y una URL de botón la resuelve el **cliente de Telegram del operador**,
// que no tiene acceso a nuestra red. Un `callback_data` lo resuelve **nuestro
// propio host** (`listener-telegram.js` → `callback-handler.js`), donde
// `localhost:3200` sí es alcanzable.
//
// Por eso la degradación primaria es `callback_data`, NUNCA texto plano: la URL
// de `human-block` porta una capability HMAC (single-use, TTL 24h) y volcarla
// como texto sería una regresión de exposición de secretos. Ventaja colateral:
// el `callback_data` no necesita token — la authz la aplica el listener con
// allowlist fail-closed por `from.id` (`listener-telegram.js`), un control más
// fuerte que un token embebido en una URL.
//
// Módulo PURO: sin I/O, sin red, sin filesystem. Testeable con `node --test`.
// =============================================================================
'use strict';

const net = require('net');

// Límite duro de la Bot API para `callback_data`.
const CALLBACK_DATA_MAX_BYTES = 64;

// Sufijos que resuelven a la propia máquina o a redes internas aunque sean
// nombres DNS válidos (por eso no los barre el rechazo de literales IP).
// Un item que arranca con '.' matchea sufijo Y el dominio pelado.
const DENY_SUFFIXES = Object.freeze([
    'localhost',
    '.local',
    '.internal',
    '.localhost',
    '.home.arpa',
    // DNS-a-loopback conocidos: devuelven 127.0.0.1 / la IP embebida en el nombre.
    'localtest.me',
    '.nip.io',
    '.sslip.io',
    '.traefik.me',
]);

/**
 * ¿Esta URL puede emitirse como botón `url` de Telegram?
 *
 * ALLOWLIST, nunca blocklist (una blocklist de strings es la fuente clásica del
 * bypass). Reglas, en orden:
 *
 *   1. Parseo con `new URL()` dentro de try/catch. PROHIBIDO regex sobre el
 *      string crudo. Cualquier throw → false.
 *   2. Sólo esquema `https:`. `http:` se rechaza igual que loopback (una
 *      capability en claro sobre HTTP es interceptable). `tg:`, `javascript:`,
 *      `data:` caen acá.
 *   3. Sin credenciales embebidas (`user:pass@host`).
 *   4. El hostname debe ser un nombre DNS, NO un literal IP. Se desenvuelven
 *      los corchetes de IPv6 ANTES de `net.isIP` — `net.isIP('[::1]') === 0`,
 *      o sea que sin desenvolver los 6 vectores IPv6 pasarían el guard.
 *      Rechazar literales IP barre de un saque 127.0.0.1, ::1, 0.0.0.0,
 *      169.254.169.254, 10/8, 172.16/12, 192.168/16 y 100.64/10 sin enumerar
 *      rangos. Las formas no literales (`127.1`, `2130706433`) las normaliza
 *      `new URL()` a IP y caen en esta misma regla.
 *   5. Denylist de sufijos DNS que resuelven a loopback / red interna.
 *
 * @param {*} raw
 * @returns {boolean}
 */
function isPublicButtonUrl(raw) {
    if (typeof raw !== 'string' || !raw) return false;
    let u;
    try { u = new URL(raw); }
    catch { return false; }

    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;

    // Desenvolver los corchetes de IPv6 ANTES de isIP (bypass D1/R-SEC-4).
    const host = String(u.hostname).replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return false;
    if (net.isIP(host) !== 0) return false;

    for (const suffix of DENY_SUFFIXES) {
        const bare = suffix.startsWith('.') ? suffix.slice(1) : suffix;
        if (host === bare) return false;
        if (suffix.startsWith('.') && host.endsWith(suffix)) return false;
        if (!suffix.startsWith('.') && host.endsWith('.' + suffix)) return false;
    }
    return true;
}

/**
 * Hosts explícitamente habilitados para recibir la capability en la URL.
 *
 * `isPublicButtonUrl` sólo dice "esta URL es alcanzable desde el cliente del
 * operador"; NO dice "confío en este host con un token HMAC". `https://evil.com`
 * pasa el guard de publicidad. Por eso hay un segundo gate: el hostname tiene
 * que estar en `DASHBOARD_PUBLIC_HOSTS` (CSV). Default VACÍO ⇒ degrada.
 *
 * @param {string[]|string|null} [explicit] — override (tests / callers).
 * @returns {Set<string>}
 */
function resolveHostAllowlist(explicit) {
    const raw = explicit !== undefined && explicit !== null
        ? explicit
        : process.env.DASHBOARD_PUBLIC_HOSTS;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return new Set(
        list.map(h => String(h || '').trim().toLowerCase()).filter(Boolean)
    );
}

/** `callback_data` canónico: `<prefix>:<action>[:<issue>]`. */
function buildCallbackData(prefix, action, issue) {
    const head = `${prefix}:${action}`;
    return (issue === undefined || issue === null || issue === '')
        ? head
        : `${head}:${issue}`;
}

/** ¿Entra en el límite de la Bot API? */
function fitsCallbackData(data) {
    return Buffer.byteLength(String(data), 'utf8') <= CALLBACK_DATA_MAX_BYTES;
}

/**
 * Arma el `inline_keyboard` de un set de acciones, eligiendo `url` o
 * `callback_data` según si la URL del dashboard es entregable Y confiable.
 *
 * @param {Array<Array<{action:string, text:string, issue?:number|string}>>} rows
 *        Filas del teclado. Cada item es una acción lógica.
 * @param {object} opts
 * @param {string}   opts.dashboardUrl    — base URL del dashboard.
 * @param {string}   opts.callbackPrefix  — namespace del callback (`hb`, `pp`), sin `:`.
 * @param {function} [opts.buildUrl]      — `(action, issue) => string|null`. SÓLO se
 *        invoca en modo `url`. Es acá donde el caller firma el token: si degradamos,
 *        nunca se llama y por lo tanto `actionToken.sign()` NO se invoca (CA-7).
 * @param {string[]|string|null} [opts.hostAllowlist] — override de DASHBOARD_PUBLIC_HOSTS.
 * @returns {{markup:object|undefined, degraded:boolean, degradedText:string}}
 */
function buildActionKeyboard(rows, opts = {}) {
    const prefix = String(opts.callbackPrefix || '').replace(/:+$/, '');
    const normalized = (Array.isArray(rows) ? rows : [])
        .map(row => (Array.isArray(row) ? row : [])
            .filter(b => b && typeof b.action === 'string' && b.action && typeof b.text === 'string' && b.text))
        .filter(row => row.length > 0);

    // `degradedText` = SÓLO el nombre de cada acción. Nunca la URL, nunca el
    // token (R1.2 / CA-7). Es el último recurso, para cuando ni el callback
    // está disponible.
    const degradedText = normalized.flat().map(b => b.text).join(' · ');

    if (!normalized.length) {
        return { markup: undefined, degraded: false, degradedText: '' };
    }

    const dashboardUrl = String(opts.dashboardUrl || '');
    let urlModeEnabled = false;
    if (typeof opts.buildUrl === 'function' && isPublicButtonUrl(dashboardUrl)) {
        // Segundo gate: además de pública, tiene que estar habilitada a portar
        // la capability. Default vacío ⇒ degrada.
        try {
            const allow = resolveHostAllowlist(opts.hostAllowlist);
            const host = new URL(dashboardUrl).hostname.toLowerCase();
            urlModeEnabled = allow.has(host);
        } catch { urlModeEnabled = false; }
    }

    // --- Modo `url`: camino feliz, sin regresión. ---
    if (urlModeEnabled) {
        const urlRows = normalized
            .map(row => row.map((b) => {
                let href = null;
                try { href = opts.buildUrl(b.action, b.issue); }
                catch { href = null; }
                if (!href || typeof href !== 'string') return null;
                return { text: b.text, url: href };
            }).filter(Boolean))
            .filter(row => row.length > 0);
        if (urlRows.length) {
            return { markup: { inline_keyboard: urlRows }, degraded: false, degradedText };
        }
        // Si el modo url no produjo NINGÚN botón (p. ej. el módulo de token no
        // está disponible), degradamos en vez de quedarnos sin acciones.
    }

    // --- Modo degradado: `callback_data`, resuelto por nuestro propio host. ---
    const cbRows = normalized
        .map(row => row.map((b) => {
            const data = buildCallbackData(prefix, b.action, b.issue);
            // Assert de longitud DENTRO del helper (CA-6): si mañana crece
            // ACTION_META, el botón se cae acá en vez de romper el envío entero.
            if (!fitsCallbackData(data)) return null;
            return { text: b.text, callback_data: data };
        }).filter(Boolean))
        .filter(row => row.length > 0);

    if (!cbRows.length) {
        // Contrato preservado (CA-UX-7): sin material para botones ⇒ undefined,
        // y el caller manda el resumen igual, sólo sin teclado.
        return { markup: undefined, degraded: true, degradedText };
    }
    return { markup: { inline_keyboard: cbRows }, degraded: true, degradedText };
}

/**
 * Parsea un `callback_data` emitido por `buildActionKeyboard`.
 * Devuelve `null` si no matchea el prefijo esperado.
 *
 * @param {string} data
 * @param {string} prefix — sin `:`.
 * @returns {{action:string, issue:string|null}|null}
 */
function parseCallbackData(data, prefix) {
    const d = typeof data === 'string' ? data : '';
    const head = `${String(prefix).replace(/:+$/, '')}:`;
    if (!d.startsWith(head)) return null;
    const parts = d.slice(head.length).split(':');
    const action = parts.shift() || '';
    if (!action) return null;
    return { action, issue: parts.length ? parts.join(':') : null };
}

module.exports = {
    isPublicButtonUrl,
    buildActionKeyboard,
    buildCallbackData,
    parseCallbackData,
    resolveHostAllowlist,
    fitsCallbackData,
    CALLBACK_DATA_MAX_BYTES,
    DENY_SUFFIXES,
};
