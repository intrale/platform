// =============================================================================
// ssrf-guard.js — Prevención SSRF IPv4 + IPv6 con mitigación DNS rebinding
// Issue #2307 · CA-9 / CA-13 / CA-20
//
// Qué bloquea:
//   IPv4:
//     - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
//     - Link-local: 169.254.0.0/16
//     - Loopback: 127.0.0.0/8, localhost, 0.0.0.0
//     - CGNAT: 100.64.0.0/10 (opt-in sobre RFC6598 pero mayoritariamente interno)
//     - Multicast/broadcast/reserved
//   IPv6:
//     - ::1 (loopback)
//     - ::     (unspecified)
//     - fe80::/10 (link-local)
//     - fc00::/7 (ULA)
//     - IPv4-mapped: ::ffff:a.b.c.d → aplica reglas IPv4
//
// Rebinding:
//   resolveAll(host) → lista TODAS las A/AAAA. Si CUALQUIERA es privada,
//   aborta. Devuelve además una IP "safe" para conectar directo y preservar
//   SNI (CA-20: el caller setea servername al hostname original).
// =============================================================================
'use strict';

const net = require('node:net');
const dnsPromises = require('node:dns/promises');

const { ERROR_CODES } = require('./constants');

// Parse un entero de la forma "a.b.c.d" a u32 big-endian.
function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let v = 0;
    for (const p of parts) {
        if (!/^\d+$/.test(p)) return null;
        const n = Number(p);
        if (n < 0 || n > 255) return null;
        v = (v * 256) + n;
    }
    return v >>> 0;
}

// Chequea si `ip` (u32) cae en el rango CIDR `baseCidr` de la forma "a.b.c.d/N".
function inCidr(ipInt, baseCidr) {
    const [baseStr, bitsStr] = baseCidr.split('/');
    const base = ipv4ToInt(baseStr);
    const bits = Number(bitsStr);
    if (base == null || !Number.isFinite(bits)) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (base & mask);
}

const BLOCKED_IPV4_CIDRS = [
    '0.0.0.0/8',        // Current network, 0.0.0.0
    '10.0.0.0/8',       // RFC 1918
    '100.64.0.0/10',    // CGNAT (RFC 6598)
    '127.0.0.0/8',      // Loopback
    '169.254.0.0/16',   // Link-local
    '172.16.0.0/12',    // RFC 1918
    '192.0.0.0/24',     // IETF reserved
    '192.168.0.0/16',   // RFC 1918
    '198.18.0.0/15',    // Benchmarking
    '224.0.0.0/4',      // Multicast
    '240.0.0.0/4',      // Reserved / broadcast (incluye 255.255.255.255)
];

function isBlockedIPv4(ip) {
    const n = ipv4ToInt(ip);
    if (n == null) return false;
    for (const c of BLOCKED_IPV4_CIDRS) {
        if (inCidr(n, c)) return true;
    }
    return false;
}

/**
 * Expande "::" y parsea a array de 8 enteros de 16 bits. Soporta
 * IPv4-mapped ("::ffff:1.2.3.4").
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIPv6(ip) {
    if (typeof ip !== 'string') return null;
    let s = ip;
    // Quitar zona: "fe80::1%eth0"
    const pct = s.indexOf('%');
    if (pct !== -1) s = s.slice(0, pct);

    // IPv4-mapped / IPv4-compatible.
    let tail = null;
    const lastColon = s.lastIndexOf(':');
    if (lastColon !== -1 && s.indexOf('.', lastColon) !== -1) {
        const v4 = s.slice(lastColon + 1);
        const v4int = ipv4ToInt(v4);
        if (v4int == null) return null;
        tail = [(v4int >>> 16) & 0xffff, v4int & 0xffff];
        s = s.slice(0, lastColon + 1) + '0:0';
    }

    // Separar por "::"
    let head, rest;
    if (s.includes('::')) {
        const [a, b] = s.split('::');
        head = a ? a.split(':') : [];
        rest = b ? b.split(':') : [];
    } else {
        head = s.split(':');
        rest = [];
    }
    const groupsNeeded = 8;
    if (head.length + rest.length > groupsNeeded) return null;
    const zeros = new Array(groupsNeeded - head.length - rest.length).fill('0');
    const full = [...head, ...zeros, ...rest];
    if (full.length !== groupsNeeded) return null;

    const out = [];
    for (const g of full) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
    }

    // Si teníamos tail (IPv4-mapped), reemplazar los últimos dos grupos.
    if (tail) {
        out[6] = tail[0];
        out[7] = tail[1];
    }

    return out;
}

function isBlockedIPv6(ip) {
    const g = parseIPv6(ip);
    if (!g) return false;

    // ::   (unspecified)
    if (g.every((x) => x === 0)) return true;
    // ::1  (loopback)
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
    // IPv4-mapped ::ffff:a.b.c.d → usar reglas v4
    if (
        g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
        g[4] === 0 && g[5] === 0xffff
    ) {
        const ipv4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
        return isBlockedIPv4(ipv4);
    }
    // IPv4-compatible ::a.b.c.d (casi todos reservados)
    if (
        g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
        g[4] === 0 && g[5] === 0 && (g[6] !== 0 || g[7] !== 0)
    ) {
        const ipv4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
        return isBlockedIPv4(ipv4);
    }
    // fe80::/10 link-local (primeros 10 bits: 1111 1110 10xx xxxx)
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // fc00::/7 ULA (primeros 7 bits: 1111 110x)
    if ((g[0] & 0xfe00) === 0xfc00) return true;

    return false;
}

/**
 * Clasifica un hostname o IP literal como bloqueado.
 * - "localhost" → bloqueado
 * - IPv4 literal → reglas v4
 * - IPv6 literal → reglas v6
 * - hostname resoluble → usar validateHostname() en su lugar
 *
 * @param {string} hostOrIp
 * @returns {boolean}
 */
function isBlockedLiteral(hostOrIp) {
    if (!hostOrIp || typeof hostOrIp !== 'string') return false;
    const lower = hostOrIp.toLowerCase();
    if (lower === 'localhost' || lower === 'localhost.localdomain') return true;

    // Soportar "[::1]" forma con brackets.
    const clean = hostOrIp.startsWith('[') && hostOrIp.endsWith(']')
        ? hostOrIp.slice(1, -1)
        : hostOrIp;

    if (net.isIPv4(clean)) return isBlockedIPv4(clean);
    if (net.isIPv6(clean)) return isBlockedIPv6(clean);
    return false;
}

function buildSSRFError(msg, code = ERROR_CODES.SSRF_BLOCKED) {
    const err = new Error(
        `[HTTP_SSRF_BLOCKED]: ${msg} → si es intencional, agregar a whitelist de proxy (.pipeline/config/proxy-allowlist.json) o usar un endpoint público`
    );
    err.code = code;
    return err;
}

/**
 * Valida que el hostname resuelva SOLO a IPs públicas (CA-9 + CA-13).
 * Devuelve la lista completa de IPs validadas, útil para un `lookup` custom
 * que preserve SNI (CA-20).
 *
 * Si el host ya es literal IPv4/IPv6, valida ese literal sin DNS.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {object} [opts.dnsResolver] - inyectable para tests (default dns/promises)
 * @returns {Promise<{ family:4|6, address:string }[]>}
 * @throws {Error} con `code = ERR_SSRF_BLOCKED` si alguna IP es privada.
 */
async function validateHostname(host, opts) {
    if (!host || typeof host !== 'string') {
        throw buildSSRFError('hostname vacío o inválido');
    }
    const resolver = (opts && opts.dnsResolver) || dnsPromises;
    const lower = host.toLowerCase();

    // Rechazar localhost / 0.0.0.0 / ::1 literal antes de tocar DNS.
    const clean = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (lower === 'localhost' || lower === 'localhost.localdomain') {
        throw buildSSRFError('hostname local (localhost) rechazado por política de seguridad');
    }
    if (net.isIPv4(clean)) {
        if (isBlockedIPv4(clean)) {
            throw buildSSRFError(`IP privada ${clean} rechazada por política de seguridad (CA-9)`);
        }
        return [{ family: 4, address: clean }];
    }
    if (net.isIPv6(clean)) {
        if (isBlockedIPv6(clean)) {
            throw buildSSRFError(`IP privada IPv6 ${clean} rechazada por política de seguridad (CA-13)`);
        }
        return [{ family: 6, address: clean }];
    }

    // Resolver todas las A + AAAA.
    let entries;
    try {
        entries = await resolver.lookup(host, { all: true, verbatim: true });
    } catch (err) {
        // Propagar pero con mensaje traducido.
        const wrapped = new Error(`[HTTP_DNS_FAIL]: no se pudo resolver el hostname ${host} (${err.code || 'ERR'}) → verificar DNS y spelling del host`);
        wrapped.code = err.code || 'ENOTFOUND';
        wrapped.cause = err;
        throw wrapped;
    }

    if (!entries || entries.length === 0) {
        throw buildSSRFError(`DNS no devolvió IPs para ${host}`);
    }

    for (const e of entries) {
        const ip = e.address;
        if (e.family === 4 && isBlockedIPv4(ip)) {
            throw buildSSRFError(`DNS rebinding: ${host} resuelve a IP privada ${ip}`);
        }
        if (e.family === 6 && isBlockedIPv6(ip)) {
            throw buildSSRFError(`DNS rebinding: ${host} resuelve a IP privada IPv6 ${ip}`);
        }
    }

    return entries;
}

module.exports = {
    isBlockedIPv4,
    isBlockedIPv6,
    isBlockedLiteral,
    validateHostname,
    parseIPv6,
    BLOCKED_IPV4_CIDRS,
};
