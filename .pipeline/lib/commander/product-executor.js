// =============================================================================
// product-executor.js — Ejecuta la acción product-aware YA autorizada + confirmada
// Issue #4780 (Ola Puente P6, split de #4691 §4.7) — Telegram Commander
// product-aware.
//
// QUÉ RESUELVE
// ------------
// `product-command.js` clasifica + autoriza + confirma (SR-1..7) pero es PURO:
// no muta estado. Este módulo cierra el último tramo del flujo end-to-end que el
// PO exigió (rechazo rev-1): tras `confirm()` OK, EJECUTAR el side-effect real
// sobre el producto. Sin esto los primitivos de seguridad quedan como código
// muerto en runtime.
//
// ALCANCE DE EJECUCIÓN (honesto)
// ------------------------------
// Sólo las acciones de CONTROL DE PIPELINE con efecto bien definido HOY:
//   - `pause`  → halt total del dispatch (marker `.paused`).
//   - `resume` → levanta halt total + pausa parcial.
// La mutación NO se escribe a mano (prohibido por security A08: el marker
// `.paused` lo posee `partial-pause.js`). Se delega a `setFullPause`/
// `clearFullPause`/`resumeAll` — write atómico bajo lock + audit de mutación.
//
// Nota product-scoping: mientras el registry sólo resuelve el producto default
// (`Intrale`, sintetizado del operador único histórico), pausar ese producto
// equivale al halt global del pipeline — que es su realidad física actual. La
// segmentación física del dispatch por producto es trabajo hermano de la Ola
// Puente; la frontera de AUTORIZACIÓN por producto (SR-1) sí se enforcea ya
// (un operador no autorizado nunca llega a `execute`). `approve`/`reject`/`sign`
// son acciones por-issue (canal `operator-gate` con botones) y NO se ejecutan a
// nivel producto acá → `{ executed:false }` explícito (nunca respuesta que
// mienta "hecho").
// =============================================================================
'use strict';

const path = require('path');

// Comandos con ejecución product-level real en este split.
const EXECUTABLE = Object.freeze(new Set(['pause', 'resume']));

/**
 * Carga best-effort del envoltorio único de estado operativo (#5179 grupo 3),
 * que delega en `partial-pause.js` (dueño del marker) bajo lock + audit.
 * Fail-open: si no cargara, `execute` devuelve `{ executed:false }` en vez de
 * romper el listener.
 */
function safeLoadOperationalState() {
    try {
        return require('../operational-state');
    } catch (_) {
        return null;
    }
}

/**
 * Crea el ejecutor de acciones product-aware.
 *
 * @param {object} [opts]
 * @param {object} [opts.operationalState] envoltorio de estado inyectable (tests).
 * @param {object} [opts.partialPause]     alias legacy del seam anterior (#5179).
 * @param {function} [opts.now]            clock inyectable.
 * @returns {{ execute: function, EXECUTABLE: Set<string> }}
 */
function createProductExecutor(opts = {}) {
    // Seam de inyección preservado: `operationalState` es el nombre nuevo,
    // `partialPause` se mantiene como alias para no romper callers existentes.
    const stateMod = opts.operationalState || opts.partialPause || safeLoadOperationalState();
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    /**
     * Ejecuta la acción sobre el producto. El caller DEBE haber pasado por
     * `product-command.confirm()` OK (authz + nonce anti-TOCTOU) antes de llamar
     * acá: este módulo NO re-autoriza (esa frontera vive aguas arriba, SR-1/SR-2).
     *
     * @param {string} command      comando confirmado (`pause`|`resume`).
     * @param {string} productId    producto resuelto server-side (del nonce).
     * @param {string} productName  nombre humano para la traza de auditoría.
     * @returns {{ executed: boolean, effect?: string, reason?: string,
     *            productId: string, removedFull?: boolean, removedPartial?: boolean }}
     */
    function execute(command, productId, productName) {
        if (!EXECUTABLE.has(command)) {
            return { executed: false, reason: 'unsupported-at-product-level', productId };
        }
        if (!stateMod) {
            return { executed: false, reason: 'partial-pause-unavailable', productId };
        }

        // #5179 D2 — `product-commander:<productId>` queda FUERA del enum cerrado
        // a propósito: el modelo de identidad de producto se decide en #5165. El
        // valor se preserva tal cual (el envoltorio sólo exige string no vacío).
        const authorizedBy = `product-commander:${productId}`;
        const stamp = new Date(now()).toISOString();

        try {
            if (command === 'pause') {
                const r = stateMod.setFullPause({
                    source: 'telegram',
                    authorizedBy,
                    justification: `Pausa de ${productName || productId} desde Commander product-aware (#4780) @ ${stamp}`,
                    extra: { productId, origen: 'telegram', issue: 4780 },
                });
                return {
                    executed: !!(r && r.ok),
                    effect: 'full-pause',
                    productId,
                    existedBefore: !!(r && r.existedBefore),
                };
            }

            // resume: levantar halt total + pausa parcial (paridad con /reanudar).
            const r = stateMod.resumeAll({
                source: 'telegram',
                authorizedBy: `resume:${authorizedBy}`,
                justification: `Reanudar ${productName || productId} desde Commander product-aware (#4780) @ ${stamp}`,
            });
            return {
                executed: true,
                effect: 'full-resume',
                productId,
                removedFull: !!(r && r.removedFull),
                removedPartial: !!(r && r.removedPartial),
            };
        } catch (e) {
            return { executed: false, reason: `error:${e.message}`, productId };
        }
    }

    return { execute, EXECUTABLE };
}

module.exports = { createProductExecutor, EXECUTABLE };
