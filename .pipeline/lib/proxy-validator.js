// =============================================================================
// proxy-validator.js — Match exacto contra whitelist de proxies
// Issue #2307 · CA-8 / CA-15
//
// Reglas:
//  - Whitelist es un array de strings "hostname:port" exactos. Cero regex,
//    cero wildcards, cero startsWith.
//  - Comparación case-insensitive del hostname; puerto exacto.
//  - Hostname normalizado a punycode (mitiga homógrafos Unicode).
//  - Auth embebida (user:pass@host) SIEMPRE se strippea antes de loguear.
//  - URL con userinfo fuera de la whitelist → rechaza (CA-15).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { ERROR_CODES } = require('./constants');

const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, '..', 'config', 'proxy-allowlist.json');

// Cache simple por path+mtime para no parsear en cada call.
const cache = new Map();

/**
 * Lee la whitelist desde disco. Devuelve array de strings "host:port" normalizados.
 * @param {string} [allowlistPath]
 * @returns {string[]}
 */
function loadAllowlist(allowlistPath) {
    const p = allowlistPath || DEFAULT_ALLOWLIST_PATH;
    let stat;
    try {
        stat = fs.statSync(p);
    } catch (e) {
        // Archivo ausente = allowlist vacía (seguro por default).
        cache.set(p, { mtime: 0, list: [] });
        return [];
    }
    const cached = cache.get(p);
    if (cached && cached.mtime === stat.mtimeMs) return cached.list;

    const raw = fs.readFileSync(p, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`[HTTP_PROXY_CONFIG]: allowlist JSON inválido en ${p}: ${e.message} → revisar .pipeline/config/proxy-allowlist.json`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`[HTTP_PROXY_CONFIG]: allowlist debe ser un array de strings "host:port" → revisar ${p}`);
    }

    const list = parsed.map((entry, i) => {
        if (typeof entry !== 'string') {
            throw new Error(`[HTTP_PROXY_CONFIG]: entrada [${i}] no es string → revisar ${p}`);
        }
        // Validar forma "host:port". Cero wildcards, cero regex.
        if (entry.includes('*') || entry.includes('?') || /\/|\\/.test(entry)) {
            throw new Error(`[HTTP_PROXY_CONFIG]: entrada [${i}] "${entry}" contiene wildcards o separadores inválidos → solo se acepta "host:port" exacto (CA-8)`);
        }
        return normalizeHostPort(entry);
    });

    cache.set(p, { mtime: stat.mtimeMs, list });
    return list;
}

/**
 * Convierte un string "host:port" a forma canónica:
 * lowercase + punycode + trim. Incluye "[ipv6]:port".
 * @param {string} hostPort
 * @returns {string}
 */
function normalizeHostPort(hostPort) {
    const raw = String(hostPort).trim();
    if (!raw) throw new Error('[HTTP_PROXY_CONFIG]: host:port vacío');
    // CA-8: cero wildcards, cero regex, cero separadores de path.
    if (raw.includes('*') || raw.includes('?') || /[\/\\]/.test(raw)) {
        throw new Error(`[HTTP_PROXY_CONFIG]: "${raw}" contiene wildcards o separadores inválidos → solo se acepta "host:port" exacto (CA-8)`);
    }

    // [ipv6]:port
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        if (end === -1 || raw[end + 1] !== ':') {
            throw new Error(`[HTTP_PROXY_CONFIG]: IPv6 mal formado en "${raw}" → formato esperado "[ipv6]:port"`);
        }
        const host = raw.slice(1, end).toLowerCase();
        const port = raw.slice(end + 2);
        if (!/^\d+$/.test(port)) {
            throw new Error(`[HTTP_PROXY_CONFIG]: puerto inválido en "${raw}"`);
        }
        return `[${host}]:${port}`;
    }

    const colon = raw.lastIndexOf(':');
    if (colon === -1) {
        throw new Error(`[HTTP_PROXY_CONFIG]: entrada "${raw}" debe ser "host:port" (CA-8)`);
    }
    const hostRaw = raw.slice(0, colon);
    const port = raw.slice(colon + 1);
    if (!/^\d+$/.test(port)) {
        throw new Error(`[HTTP_PROXY_CONFIG]: puerto inválido en "${raw}"`);
    }
    const host = toPunycodeLower(hostRaw);
    return `${host}:${port}`;
}

/**
 * Convierte un hostname a lowercase + punycode (sin depender de módulo
 * `punycode` deprecado). Si node no soporta el parseo, devuelve lowercase.
 * @param {string} host
 * @returns {string}
 */
function toPunycodeLower(host) {
    const lower = String(host).toLowerCase();
    // Usar URL para forzar codificación IDN (Node emite hostname en punycode).
    try {
        const u = new URL(`http://${lower}/`);
        return u.hostname; // ya es lowercase + punycode si aplica
    } catch (_) {
        return lower;
    }
}

/**
 * Strippea userinfo (user:pass@) de una URL antes de loguear.
 * Nunca deja la auth visible, aunque la URL sea inválida.
 * @param {string} url
 * @returns {string}
 */
function stripUserinfo(url) {
    if (typeof url !== 'string') return url;
    return url.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

function buildProxyError(msg) {
    const err = new Error(`[HTTP_PROXY_BLOCKED]: ${msg} → revisar .pipeline/config/proxy-allowlist.json`);
    err.code = ERROR_CODES.PROXY_NOT_WHITELISTED;
    return err;
}

/**
 * Verifica si la URL dada corresponde a un proxy autorizado.
 *
 * Semántica:
 *  - Devuelve `{ host, port, hostPort, auth }` si matchea EXACTAMENTE una
 *    entrada de la whitelist (proxy autorizado).
 *  - Si la URL no es proxy (es decir, no se pretende usar como proxy),
 *    el caller debe NO llamar a esta función.
 *  - Si la URL contiene userinfo y NO está en whitelist → lanza ERR_USERINFO_BLOCKED.
 *  - Si el host:port no está en whitelist → lanza ERR_PROXY_NOT_WHITELISTED.
 *
 * @param {string} proxyUrl
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist] - inyección directa (bypass del archivo)
 * @param {string} [opts.allowlistPath] - path a archivo JSON alternativo
 * @returns {{host:string,port:number,hostPort:string,auth:string|null}}
 * @throws {Error} con code ERR_PROXY_NOT_WHITELISTED o ERR_USERINFO_BLOCKED
 */
function validateProxy(proxyUrl, opts) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        throw buildProxyError('proxyUrl vacío o inválido');
    }
    let parsed;
    try {
        parsed = new URL(proxyUrl);
    } catch (_) {
        throw buildProxyError(`proxy URL no parseable: ${stripUserinfo(proxyUrl)}`);
    }
    const host = parsed.hostname.toLowerCase(); // URL ya decodifica IDN a punycode
    const port = parsed.port || defaultPortForProtocol(parsed.protocol);
    if (!port) {
        throw buildProxyError(`proxy URL sin puerto: ${stripUserinfo(proxyUrl)}`);
    }
    const hostPort = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;

    const list = (opts && opts.allowlist) || loadAllowlist(opts && opts.allowlistPath);
    const matched = list.includes(hostPort);

    // Auth embebida: solo se acepta si el host:port matchea whitelist.
    const hasAuth = !!(parsed.username || parsed.password);
    if (hasAuth && !matched) {
        const err = new Error(
            `[HTTP_USERINFO_BLOCKED]: URL con userinfo fuera de la whitelist de proxy: ${stripUserinfo(proxyUrl)} → la auth embebida solo se permite en proxies autorizados (CA-15)`
        );
        err.code = ERROR_CODES.USERINFO_BLOCKED;
        throw err;
    }

    if (!matched) {
        throw buildProxyError(`proxy ${hostPort} no está en whitelist`);
    }

    return {
        host,
        port: Number(port),
        hostPort,
        auth: hasAuth ? `${parsed.username}:${parsed.password}` : null,
    };
}

function defaultPortForProtocol(proto) {
    if (proto === 'http:') return '80';
    if (proto === 'https:') return '443';
    return null;
}

/**
 * Dado un hostname y puerto, ¿están en la whitelist? (para chequeo manual sin URL)
 * @param {string} host
 * @param {number|string} port
 * @param {object} [opts]
 * @returns {boolean}
 */
function isAllowedHostPort(host, port, opts) {
    const list = (opts && opts.allowlist) || loadAllowlist(opts && opts.allowlistPath);
    const lower = toPunycodeLower(String(host));
    const hostPort = lower.includes(':') ? `[${lower}]:${port}` : `${lower}:${port}`;
    return list.includes(hostPort);
}

/**
 * Limpia la cache (útil para tests).
 */
function _clearCache() {
    cache.clear();
}

module.exports = {
    validateProxy,
    isAllowedHostPort,
    loadAllowlist,
    normalizeHostPort,
    stripUserinfo,
    toPunycodeLower,
    _clearCache,
};
