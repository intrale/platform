'use strict';
// =============================================================================
// #7631 — Dirección humana desde el audit encadenado del canal de firma
// (CA-4 · S6 · SEC-D · SEC-E · SEC-F).
//
// Fuente ÚNICA: `.pipeline/audit/approval-channel.jsonl`, escrito por
// `approval-channel.js` (paso 14 de `submitSignature`) con `appendChained`.
// No hay fallback a otra fuente sin cadena: si la entrada no está, es `missing`.
//
// Mapeo de gates reales del canal (validación técnica del guru, fase validación):
//   gate 'aceptacion' → gate2 (ancla `commit-sha`, verdicts signed|rejected)
//   gate 'definicion' → gate1 (ancla `body-hash`, verdicts signed|re-definition|rejected)
//   'approval'        → sin fuente hoy; queda en el orden de peso por contrato.
// =============================================================================

const crypto = require('crypto');
const path = require('path');
const { verifyChain } = require('../audit-log');
const { sanitizeTrailerValue } = require('./trailer');

// MISMA ruta que el escritor (`approval-channel.js` usa `trace.REPO_ROOT`, que
// resuelve el repo principal por el git common dir): desde un worktree, la ruta
// relativa a este archivo apuntaría a un audit que nadie escribe.
function pipelineDir() {
    try { return path.join(require('../traceability').REPO_ROOT, '.pipeline'); }
    catch { return path.join(__dirname, '..', '..'); }
}
const DEFAULT_AUDIT_FILE = path.join(pipelineDir(), 'audit', 'approval-channel.jsonl');

const REASONS = Object.freeze({
    MISSING: 'missing',
    CHAIN_BROKEN: 'chain-broken',
    ANCHOR_MISMATCH: 'anchor-mismatch',
    UNMAPPED: 'unmapped',
});

const GATE_TO_KIND = Object.freeze({ aceptacion: 'gate2', definicion: 'gate1', approval: 'approval' });
const KIND_WEIGHT = Object.freeze(['gate2', 'gate1', 'approval']); // mayor peso primero
const VALID_CHANNELS = Object.freeze(['telegram', 'dashboard']);

/** Clave del `identity_map`: `sha256:<hex>` del `signed_by` (SEC-F / Riesgo 3). */
function identityKey(signedBy) {
    return `sha256:${crypto.createHash('sha256').update(String(signedBy), 'utf8').digest('hex')}`;
}

function toIso(entry) {
    if (typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at))) {
        return new Date(Date.parse(entry.at)).toISOString();
    }
    if (Number.isFinite(Number(entry.created_at))) return new Date(Number(entry.created_at)).toISOString();
    return null;
}

/**
 * @param {object} p
 * @param {number} p.issue
 * @param {string} p.headSha — el MISMO `sha=` que viaja al PUT del merge.
 * @param {string} [p.auditFile]
 * @param {object} [p.fsImpl]
 * @param {object} [p.identityMap] — `{ 'sha256:<hex>': 'login' }`.
 * @returns {{ok:true, login:string, ts:string, kind:string, hash:string}
 *          |{ok:false, reason:string}}
 */
function resolveHumanDirection({ issue, headSha, auditFile = DEFAULT_AUDIT_FILE, fsImpl, identityMap } = {}) {
    const _fs = fsImpl || require('fs');
    const n = Number(issue);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: REASONS.MISSING };

    // Una sola lectura por evaluación (Riesgo 6): el mismo contenido alimenta
    // `verifyChain` y la selección, así no hay ventana entre verificar y leer.
    let content;
    try {
        if (!_fs.existsSync(auditFile)) return { ok: false, reason: REASONS.MISSING };
        content = _fs.readFileSync(auditFile, 'utf8');
    } catch {
        // No poder leer el registro NO es "no hay firma": es no poder acreditar
        // la integridad. Fail-closed igual, con el motivo correcto.
        return { ok: false, reason: REASONS.CHAIN_BROKEN };
    }
    const memFs = { existsSync: () => true, readFileSync: () => content };
    let chain;
    try { chain = verifyChain(auditFile, memFs); } catch { chain = { ok: false }; }
    if (!chain || chain.ok !== true) return { ok: false, reason: REASONS.CHAIN_BROKEN };

    const entries = [];
    for (const line of String(content).split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { return { ok: false, reason: REASONS.CHAIN_BROKEN }; }
    }

    // Última entrada de cada tipo, en el orden de la cadena (P2).
    const lastByKind = {};
    for (const e of entries) {
        if (!e || e.type !== 'approval_channel_signature') continue;
        if (Number(e.issue) !== n) continue;
        // Comparación EXACTA, sin trim ni lower (SEC-D): `Telegram ` no cuenta.
        if (typeof e.channel !== 'string' || !VALID_CHANNELS.includes(e.channel)) continue;
        const kind = GATE_TO_KIND[e.gate];
        if (!kind) continue;
        lastByKind[kind] = e;
    }

    let winner = null;
    let winnerKind = null;
    for (const kind of KIND_WEIGHT) {
        const e = lastByKind[kind];
        if (e && e.verdict === 'signed') { winner = e; winnerKind = kind; break; }
    }
    if (!winner) return { ok: false, reason: REASONS.MISSING };

    // Una firma de GATE 2 sobre otro commit es una señal, no un empate: no se
    // degrada a gate1.
    if (winnerKind === 'gate2') {
        const sha = String(headSha || '').toLowerCase();
        if (winner.anchor_kind !== 'commit-sha' || !sha || String(winner.anchor_value || '').toLowerCase() !== sha) {
            return { ok: false, reason: REASONS.ANCHOR_MISMATCH };
        }
    }

    // Identidad: el `signed_by` crudo (chat_id de Telegram) NUNCA se emite.
    const map = identityMap && typeof identityMap === 'object' ? identityMap : {};
    const mapped = Object.prototype.hasOwnProperty.call(map, identityKey(winner.signed_by))
        ? map[identityKey(winner.signed_by)] : null;
    let login;
    try { login = sanitizeTrailerValue(mapped); } catch { return { ok: false, reason: REASONS.UNMAPPED }; }

    const ts = toIso(winner);
    const hash = String(winner.hash_self || '');
    if (!ts || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: REASONS.CHAIN_BROKEN };

    return { ok: true, login, ts, kind: winnerKind, hash };
}

module.exports = {
    resolveHumanDirection,
    identityKey,
    REASONS,
    GATE_TO_KIND,
    VALID_CHANNELS,
    DEFAULT_AUDIT_FILE,
};
