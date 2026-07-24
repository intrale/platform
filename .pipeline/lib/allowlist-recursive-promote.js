// =============================================================================
// allowlist-recursive-promote.js — Auto-promoción de hijos cuando el planner
// hace split sobre un issue padre que está en la allowlist (#3625 CA-3).
//
// Origen: la regla `allowlist-recursive-deps` del proyecto ("al sumar issue
// a allowlist incluir recursivamente hijos/dependencias/bloqueos") no estaba
// automatizada. Cuando planner divide #N → hijos H1, H2, H3, los hijos
// quedaban fuera del allowlist a menos que el operador los agregara a mano.
//
// Diseño cerrado por PO/security en #3625:
//
//   1. Trigger: hook server-side post-skill-success cuando intent=split
//      detectó hijos creados via `outcome.issuesCreated` (commander).
//   2. Sólo promover los hijos declarados explícitamente (no labels GitHub).
//   3. Cada hijo entra con `authorizedBy: 'recursive-deps:from-<N>'` (N=padre).
//   4. TTL de 48h sobre la autoría heredada — si el hijo no se procesa en
//      48h, expira y requiere re-autorización humana. Evita acumulación
//      silenciosa de autorizaciones obsoletas (vector A04:2021 — Insecure
//      Design).
//   5. Si el padre NO estaba en allowlist → no se auto-promueve nada.
//   6. Si el hook falla por excepción → NO promueve + notificación Telegram
//      al operador para autorización manual (security guideline).
//
// Este módulo NO modifica el JSON directamente: usa
// `lib/partial-pause.setPartialPause` con los opts adecuados, así pasa por
// el gate y queda auditado igual que cualquier otra mutación.
// =============================================================================
'use strict';

const partialPause = require('./partial-pause');
const audit = require('./partial-pause-audit');
const { notifyTelegram } = require('./notify-telegram');

const TTL_MS = 48 * 60 * 60 * 1000; // 48 horas, decisión PO #3625.

/**
 * Expande recursivamente un set semilla de issues incluyendo sus
 * dependencias/bloqueos/hijos, excluyendo cerrados. Función PURA (#4350):
 *
 *   - NO usa red / GitHub / TTL. El descubrimiento del grafo se inyecta vía
 *     `getDeps` (típicamente `waves.getBlockingIssues`, que lee el grafo
 *     `dependencies[]` de waves.json — filesystem propio).
 *   - Desacoplada del trigger de split del planner: la pertenencia a una ola
 *     NO expira, así que NO hereda el `TTL_MS` de la auto-promoción de split.
 *   - Fail-safe (SEC-4): un issue se excluye SOLO si `isClosed(n) === true`
 *     (cerrado confirmado). Estado abierto (`false`) o indeterminado
 *     (`undefined`/sin predicado) → se conserva. Nunca vacía por falso cierre.
 *   - Los issues cerrados no expanden sus dependencias (su subgrafo se asume
 *     resuelto); evita revivir cadenas cerradas.
 *   - Sanitiza a enteros positivos (SEC-3) y corta ciclos con un set `seen`.
 *
 * @param {object} params
 * @param {Array<number|string>} params.seedIssues — issues raíz (ej. ola activa).
 * @param {(n:number)=>boolean|undefined} [params.isClosed] — predicado de cierre.
 * @param {(n:number)=>Array<number|string>} [params.getDeps] — descubridor de
 *   dependencias/bloqueos de un issue. Default: sin expansión (solo semilla).
 * @returns {number[]} set expandido de issues ABIERTOS (o indeterminados),
 *   ordenado ascendente y deduplicado.
 */
function expandRecursiveOpenIssues({ seedIssues, isClosed, getDeps } = {}) {
    const isClosedFn = typeof isClosed === 'function' ? isClosed : null;
    const depsFn = typeof getDeps === 'function' ? getDeps : () => [];
    const toValid = (x) => {
        const n = Number(String(x).trim().replace(/^#/, ''));
        return Number.isInteger(n) && n > 0 ? n : null; // SEC-3
    };

    const seen = new Set();
    const open = new Set();
    const queue = [];
    for (const s of (Array.isArray(seedIssues) ? seedIssues : [])) {
        const n = toValid(s);
        if (n !== null && !seen.has(n)) { seen.add(n); queue.push(n); }
    }

    while (queue.length > 0) {
        const n = queue.shift();
        // Fail-safe: solo excluir con cierre CONFIRMADO. Indeterminado se conserva.
        const closed = isClosedFn ? isClosedFn(n) === true : false;
        if (!closed) open.add(n);
        // Un cerrado no aporta sus dependencias al set habilitado.
        if (closed) continue;
        let deps = [];
        try { deps = depsFn(n) || []; } catch { deps = []; }
        for (const d of (Array.isArray(deps) ? deps : [])) {
            const dn = toValid(d);
            if (dn !== null && !seen.has(dn)) { seen.add(dn); queue.push(dn); }
        }
    }

    return [...open].sort((a, b) => a - b);
}

/**
 * Auto-promueve hijos de un split a la allowlist si el padre está incluido.
 *
 * @param {object} params
 * @param {number} params.parentIssue — issue padre del split.
 * @param {number[]} params.childrenIssues — hijos declarados (ya validados).
 * @returns {{
 *   promoted: boolean,
 *   reason?: string,
 *   added?: number[],
 *   alreadyPresent?: number[],
 *   expiresAt?: string,
 *   gateRejected?: boolean,
 * }}
 */
function autoPromoteSplitChildren({ parentIssue, childrenIssues }) {
    const pn = Number(parentIssue);
    if (!Number.isInteger(pn) || pn <= 0) {
        return { promoted: false, reason: 'invalid_parent_issue' };
    }
    const children = (Array.isArray(childrenIssues) ? childrenIssues : [])
        .map(Number)
        .filter(n => Number.isInteger(n) && n > 0 && n !== pn);
    if (children.length === 0) {
        return { promoted: false, reason: 'no_children_declared' };
    }

    let state;
    try {
        state = partialPause.getPipelineMode();
    } catch (err) {
        // Fail-safe: si no podemos leer estado, notificar y abortar (no
        // auto-promover sin tener certeza del estado del padre).
        try {
            notifyTelegram(
                `⚠️ allowlist-recursive-promote: no pude leer el estado de allowlist para evaluar split de #${pn}. ` +
                `Hijos a promover manualmente: ${children.map(n => `#${n}`).join(', ')}.\n` +
                `Error: ${err.message}`
            );
        } catch { /* best-effort */ }
        return { promoted: false, reason: 'state_read_failed' };
    }

    if (state.mode !== 'partial_pause') {
        // No hay allowlist activa → no hay nada que auto-promover.
        return { promoted: false, reason: 'no_partial_pause_active' };
    }

    const currentAllowlist = Array.isArray(state.allowedIssues) ? state.allowedIssues : [];
    if (!currentAllowlist.includes(pn)) {
        // El padre no está autorizado → los hijos tampoco heredan.
        return { promoted: false, reason: 'parent_not_in_allowlist' };
    }

    const alreadyPresent = children.filter(n => currentAllowlist.includes(n));
    const toAdd = children.filter(n => !currentAllowlist.includes(n));

    if (toAdd.length === 0) {
        return { promoted: true, added: [], alreadyPresent, reason: 'all_children_already_present' };
    }

    const newAllowlist = [...new Set([...currentAllowlist, ...toAdd])].sort((a, b) => a - b);
    const expiresAtMs = Date.now() + TTL_MS;
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    // TTLs heredados: marcar cada hijo agregado con su expiración.
    const ttls = {};
    // Preservar TTLs previos (en `authorizationTtls` del state).
    if (state.authorizationTtls && typeof state.authorizationTtls === 'object') {
        for (const k of Object.keys(state.authorizationTtls)) {
            ttls[k] = state.authorizationTtls[k];
        }
    }
    for (const n of toAdd) {
        ttls[String(n)] = {
            parent: pn,
            authorized_by: `recursive-deps:from-${pn}`,
            expires_at: expiresAtIso,
            created_at: new Date().toISOString(),
        };
    }

    const result = partialPause.setPartialPause(newAllowlist, {
        source: 'planner-split:auto',
        authorizedBy: `recursive-deps:from-${pn}`,
        justification: `Auto-promoted children from #${pn} split (TTL 48h)`,
        authorizationTtls: ttls,
        // Preservar campos previos no críticos.
        acceptedDepRisk: state.acceptedDepRisk === true,
        depSources: state.depSources || undefined,
    });

    if (result.rejected) {
        // Cambio raro: gate rechazó. Notificar y NO promover.
        try {
            notifyTelegram(
                `🛑 allowlist-recursive-promote: el gate rechazó la promoción automática de hijos de #${pn}.\n` +
                `Hijos: ${toAdd.map(n => `#${n}`).join(', ')}\n` +
                `Razón: ${result.msg || 'unknown'}\n` +
                `Promover manualmente con /pause-partial.`
            );
        } catch { /* best-effort */ }
        return { promoted: false, gateRejected: true, reason: 'gate_rejected' };
    }

    return {
        promoted: true,
        added: toAdd,
        alreadyPresent,
        expiresAt: expiresAtIso,
    };
}

/**
 * Expira autorizaciones heredadas (recursive-deps:from-N) cuyo TTL pasó.
 *
 * Llamado por un cron del Pulpo cada hora. Si encuentra entries vencidas,
 * remueve esos issues de la allowlist con `authorizedBy: 'pulpo:cleanup'`
 * (audit entry + Telegram notify).
 *
 * @param {object} [opts]
 * @param {number} [opts.nowMs] — para tests con fake clock.
 * @returns {{ expired: number[], remaining: number[], notified: boolean }}
 */
function expireRecursiveAuthorizations({ nowMs } = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    let state;
    try {
        state = partialPause.getPipelineMode();
    } catch {
        return { expired: [], remaining: [], notified: false };
    }
    if (state.mode !== 'partial_pause') {
        return { expired: [], remaining: [], notified: false };
    }
    const ttls = (state.authorizationTtls && typeof state.authorizationTtls === 'object')
        ? state.authorizationTtls
        : null;
    if (!ttls) {
        return { expired: [], remaining: state.allowedIssues || [], notified: false };
    }

    const expired = [];
    for (const k of Object.keys(ttls)) {
        const t = ttls[k];
        if (!t || typeof t !== 'object') continue;
        const ts = Date.parse(t.expires_at);
        if (Number.isFinite(ts) && ts < now) {
            const n = Number(k);
            if (Number.isInteger(n) && n > 0) expired.push(n);
        }
    }
    if (expired.length === 0) {
        return { expired: [], remaining: state.allowedIssues || [], notified: false };
    }

    const newAllowlist = state.allowedIssues.filter(n => !expired.includes(n));
    // Filtrar también el mapa de TTLs.
    const newTtls = {};
    for (const k of Object.keys(ttls)) {
        const n = Number(k);
        if (newAllowlist.includes(n)) newTtls[k] = ttls[k];
    }

    const result = partialPause.setPartialPause(newAllowlist, {
        source: 'pulpo:cleanup',
        authorizedBy: 'pulpo:cleanup',
        justification: `TTL expired for ${expired.map(n => `#${n}`).join(', ')}`,
        authorizationTtls: newTtls,
        acceptedDepRisk: state.acceptedDepRisk === true,
        depSources: state.depSources || undefined,
    });

    let notified = false;
    if (!result.rejected) {
        try {
            notifyTelegram(
                `⏰ TTL expirado — removidos de allowlist por pulpo:cleanup: ` +
                `${expired.map(n => `#${n}`).join(', ')}.\n` +
                `Re-autorizar manualmente con /pause-partial si todavía aplican.`
            );
            notified = true;
        } catch { /* best-effort */ }
    }

    return { expired, remaining: newAllowlist, notified };
}

module.exports = {
    autoPromoteSplitChildren,
    expireRecursiveAuthorizations,
    expandRecursiveOpenIssues,
    TTL_MS,
};
