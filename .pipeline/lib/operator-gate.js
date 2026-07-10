// =============================================================================
// operator-gate.js — Canal de firma del operador para gates `waiting-operator`
// (issue #4579, épico #4570 · diseño docs/pipeline/gates-firma-operador.md).
//
// QUÉ RESUELVE
// ------------
// Un gate que devuelve el veredicto `requires-operator` (criterio no evaluable
// automáticamente, ver `docs/pipeline/contrato-kernel-adaptador.md` §5.1) deja
// el ítem en `waiting-operator/`. Este módulo es el **canal de firma**: el
// operador toca ✅/❌/✏️ en Telegram y el kernel transiciona el gate, con
// audit inmutable de cada firma.
//
// El trabajo es CABLEAR piezas existentes, no construir de cero:
//   - `action-token.js` — token HMAC firmado + `exp` corto + nonce single-use.
//   - `audit-log.js`     — audit append-only hash-chained (tamper-evident).
//   - `sherlock-audit-jsonl.redactAll` — redacción de secrets antes de persistir.
//   - `credentials.js`   — `telegram.leo_operator_chat_id` como allowlist de operador.
//
// MODELO DE SEGURIDAD (los 5 requisitos de `security` son CA no negociables)
// -------------------------------------------------------------------------
// [A01/A07] Autorización POR OPERADOR (`from.id`), no por `chat.id`. En un grupo
//   cualquier miembro puede tocar el botón; validamos `from.id` contra el
//   allowlist + binding tenant→operador resuelto SERVER-SIDE (nunca desde
//   `callback_data`). Fail-closed: sin allowlist configurado, se rechaza todo.
// [A08] `callback_data` es client-controlled y Telegram lo limita a 64 bytes —
//   un token HMAC completo no entra. Patrón: `callback_data` = **id opaco corto**
//   → lookup server-side (este store) del token firmado. Prohibido codificar la
//   transición directa (`approve:issue:4579`): sería falsificable/reproducible.
// [A09] Audit inmutable **hash-chained** (no `.jsonl` plano editable). Cada firma
//   registra actor/acción/issue/tenant/gate/ts/nonce/resultado, pasada por
//   `redactAll`. `verifyChain` detecta manipulación de cualquier firma.
// [A03/A04] Allowlist cerrada de acciones; `issue`/`tenant` del callback tratados
//   como NO confiables → validación de tipo/pertenencia antes de tocar el FS
//   (anti path-traversal al resolver el ítem en `waiting-operator/`).
// [A02] El secreto se deriva del bot token vía `deriveKey` (fuente única
//   `credentials.json`). Nunca se hardcodea ni se loguea el token/secreto/nonce.
//
// NOTA DE SECUENCIACIÓN (no bloqueante): el E2E contra un gate productor real
// depende de #4574/#4575 (OPEN). Este módulo implementa el mecanismo genérico
// contra el contrato `waiting-operator` (#4571, CLOSED); el `waitingDir` es
// inyectable para que el gate productor lo popule cuando mergee.
// =============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const trace = require('./traceability');
const { createTokenSigner, isValidIssue } = require('./action-token');
const auditLog = require('./audit-log');
const { redactAll } = require('./sherlock-audit-jsonl');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// Sólo estas tres acciones son válidas en el canal de firma (subconjunto de la
// ACTION_ALLOWLIST de action-token.js — CA-7 / A03). Congelado.
const GATE_ACTIONS = Object.freeze(['approve', 'reject', 'adjust-definicion']);

// El id opaco (callback_data) es hex corto: 16 chars = 8 bytes, holgadamente
// dentro del límite de 64 bytes de Telegram. Se valida como nombre de archivo
// del store (anti path-traversal: sólo [a-f0-9], sin separadores).
const OPAQUE_ID_RE = /^[a-f0-9]{16,64}$/;

// El tenant, cuando existe, se usa como parte de metadata (nunca como path). Se
// restringe a un slug conservador para no permitir inyección/traversal si algún
// día se usara para namespacing en disco.
const TENANT_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Resuelve el allowlist de operadores autorizados desde el entorno. Fuente:
 * `TELEGRAM_LEO_OPERATOR_CHAT_ID` (mapeado desde `telegram.leo_operator_chat_id`
 * por `credentials.js`). En chat privado 1:1 el `chat.id` del operador coincide
 * con su `from.id`, así que sirve como identidad de operador autorizado.
 *
 * Fail-closed: si no hay ninguno configurado, devuelve un Set vacío → todo
 * callback se rechaza (mejor no firmar que firmar sin autorización).
 */
function resolveOperatorAllowlist(env = process.env) {
    const ids = [];
    const leo = env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    if (leo && String(leo).trim().length > 0) ids.push(String(leo).trim());
    return new Set(ids);
}

function isValidTenant(tenant) {
    return tenant === null || tenant === undefined || tenant === ''
        ? true
        : (typeof tenant === 'string' && TENANT_RE.test(tenant));
}

/**
 * Crea una instancia del gate de firma con dependencias inyectables (para tests
 * herméticos). En producción todos los defaults apuntan a `.pipeline/`.
 *
 * @param {object} opts
 * @param {string}   [opts.pipelineDir]        raíz `.pipeline/`.
 * @param {string}   [opts.storeDir]           dir del store id opaco→token.
 * @param {string}   [opts.waitingDir]         dir de ítems `waiting-operator/`.
 * @param {string}   [opts.approvedDir]        destino de aprobación (`procesado/`).
 * @param {string}   [opts.rejectedDir]        destino de rechazo (`pendiente/`).
 * @param {string}   [opts.auditFile]          JSONL hash-chained de firmas.
 * @param {object}   [opts.signer]             token signer (default: createTokenSigner).
 * @param {Set|Array}[opts.operatorAllowlist]  ids de operador autorizados.
 * @param {object}   [opts.tenantBinding]      { tenant: [operatorId, ...] } server-side.
 * @param {function} [opts.now]                clock inyectable.
 * @param {object}   [opts.fsImpl]             fs inyectable.
 */
function createOperatorGate(opts = {}) {
    const pipelineDir = opts.pipelineDir || PIPELINE_DIR;
    const storeDir = opts.storeDir || path.join(pipelineDir, 'operator-gate', 'pending');
    const waitingDir = opts.waitingDir || path.join(pipelineDir, 'desarrollo', 'waiting-operator');
    const approvedDir = opts.approvedDir || path.join(pipelineDir, 'desarrollo', 'procesado');
    const rejectedDir = opts.rejectedDir || path.join(pipelineDir, 'desarrollo', 'pendiente');
    const auditFile = opts.auditFile || path.join(pipelineDir, 'audit', 'operator-gate-signatures.jsonl');
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    const signer = opts.signer || createTokenSigner({
        nonceFile: path.join(pipelineDir, 'audit', 'operator-gate-tokens-used.jsonl'),
        now,
    });

    const operatorAllowlist = opts.operatorAllowlist instanceof Set
        ? opts.operatorAllowlist
        : new Set((opts.operatorAllowlist || [...resolveOperatorAllowlist()]).map(String));

    const tenantBinding = opts.tenantBinding || {};

    // ---- Autorización (A01/A07) --------------------------------------------
    /**
     * ¿`fromId` está autorizado a firmar sobre `tenant`? Valida:
     *   1. `fromId` ∈ allowlist global de operadores (fail-closed si vacío).
     *   2. Si `tenant` tiene binding server-side configurado, `fromId` debe
     *      pertenecer a ese binding (multi-tenant: evita firmas cruzadas).
     *   3. Si no hay binding para el tenant, cae al operador global (default
     *      single-tenant). El binding se resuelve SIEMPRE server-side, nunca
     *      desde `callback_data`.
     */
    function isAuthorizedOperator(fromId, tenant) {
        if (fromId === null || fromId === undefined) return false;
        const id = String(fromId);
        if (!operatorAllowlist.has(id)) return false;
        if (tenant !== null && tenant !== undefined && tenant !== '') {
            const bound = tenantBinding[String(tenant)];
            if (Array.isArray(bound) && bound.length > 0) {
                return bound.map(String).includes(id);
            }
        }
        return true;
    }

    // ---- Store id opaco → token firmado (A08) ------------------------------
    function storePathFor(id) {
        if (typeof id !== 'string' || !OPAQUE_ID_RE.test(id)) return null;
        const file = path.join(storeDir, `${id}.json`);
        // Defensa redundante anti-traversal: el path resuelto DEBE caer dentro
        // de storeDir (OPAQUE_ID_RE ya lo garantiza, pero cementamos).
        const resolved = path.resolve(file);
        if (!resolved.startsWith(path.resolve(storeDir) + path.sep)) return null;
        return resolved;
    }

    /**
     * Registra un botón de firma: firma el token {issue, action}, genera el id
     * opaco corto (callback_data) y persiste el binding server-side en disco.
     * @returns {{id, callbackData, token}} — `id`/`callbackData` van al botón.
     * @throws si issue/action/tenant son inválidos (inputs no confiables).
     */
    function register({ issue, action, tenant = null } = {}) {
        const i = Number(issue);
        if (!isValidIssue(i)) throw new Error(`operator-gate.register: issue inválido (${issue})`);
        if (!GATE_ACTIONS.includes(action)) throw new Error(`operator-gate.register: action inválida (${action})`);
        if (!isValidTenant(tenant)) throw new Error(`operator-gate.register: tenant inválido (${tenant})`);

        const token = signer.sign({ issue: i, action });
        const id = crypto.randomBytes(8).toString('hex'); // 16 hex chars ≤ 64B
        const entry = {
            id, token, issue: i, action,
            tenant: tenant || null,
            created_at: new Date(now()).toISOString(),
        };
        const file = storePathFor(id);
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* idempotente */ }
        _fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
        return { id, callbackData: id, token };
    }

    /** Resuelve el id opaco → entry del store, o null si no existe/ inválido. */
    function resolve(id) {
        const file = storePathFor(id);
        if (!file) return null;
        try {
            return JSON.parse(_fs.readFileSync(file, 'utf8'));
        } catch { return null; }
    }

    /** Consume (borra) el binding del store — best-effort, idempotente. */
    function consume(id) {
        const file = storePathFor(id);
        if (!file) return;
        try { _fs.unlinkSync(file); } catch { /* ya consumido / no existe */ }
    }

    // ---- Transición del estado waiting-operator (A03/A04) ------------------
    /**
     * Mapea la acción firmada al destino del lifecycle:
     *   approve            → procesado/  (pass autorizado por humano)
     *   reject             → pendiente/  (fail autorizado, vuelve a dev)
     *   adjust-definicion  → pendiente/  (vuelve a re-definición)
     * El ítem se modela como `waiting-operator/<issue>.json`. `issue` ya está
     * validado como entero por `isValidIssue`, así que el path NO se construye
     * de string crudo (anti path-traversal — CA-7).
     *
     * Sólo el kernel ejecuta la transición (rename atómico). Si el ítem no
     * existe todavía (gate productor #4574 aún OPEN), devuelve `not-found` sin
     * fallar: el mecanismo de firma es válido aunque no haya ítem real todavía.
     */
    function applyTransition({ issue, action, tenant = null } = {}) {
        const i = Number(issue);
        if (!isValidIssue(i)) return { ok: false, status: 'invalid-issue', gate: null };
        if (!GATE_ACTIONS.includes(action)) return { ok: false, status: 'invalid-action', gate: null };

        const destDir = action === 'approve' ? approvedDir : rejectedDir;
        const gate = action === 'approve' ? 'aprobado'
            : action === 'reject' ? 'rechazado'
                : 'ajuste-definicion';

        const fileName = `${i}.json`; // i es entero validado, no string crudo
        const src = path.join(waitingDir, fileName);
        const dest = path.join(destDir, fileName);

        // Defensa redundante: ambos paths DEBEN quedar dentro de sus dirs.
        if (!path.resolve(src).startsWith(path.resolve(waitingDir) + path.sep)) {
            return { ok: false, status: 'path-escape', gate };
        }

        if (!_fs.existsSync(src)) {
            return { ok: false, status: 'not-found', gate, issue: i };
        }
        try {
            _fs.mkdirSync(destDir, { recursive: true });
        } catch { /* idempotente */ }
        try {
            _fs.renameSync(src, dest);
        } catch (e) {
            return { ok: false, status: 'rename-failed', gate, issue: i, error: e.message };
        }
        return { ok: true, status: gate, gate, issue: i, tenant: tenant || null, from: src, to: dest };
    }

    // ---- Audit inmutable hash-chained (A09) --------------------------------
    /** Persiste UNA firma en el audit chain, redactando todo campo string. */
    function auditSignature(record) {
        const entry = {
            actor: redactAll(String(record.actor)),
            action: redactAll(String(record.action)),
            issue: record.issue,
            tenant: record.tenant == null ? null : redactAll(String(record.tenant)),
            gate: record.gate == null ? null : redactAll(String(record.gate)),
            nonce: record.nonce == null ? null : redactAll(String(record.nonce)),
            result: redactAll(String(record.result)),
            ts: new Date(now()).toISOString(),
        };
        return auditLog.appendChained({ file: auditFile, entry, fsImpl: _fs });
    }

    // ---- Copy de los toasts (A-oper / UX, sin filtrar info sensible) -------
    function successToast(action, issue, transition) {
        if (action === 'approve') {
            return transition.ok
                ? `✅ Aprobado — #${issue} avanza`
                : `⚠️ #${issue}: aprobado, pero no encontré el ítem para avanzar`;
        }
        if (action === 'reject') {
            return transition.ok
                ? `❌ Rechazado — #${issue} vuelve a desarrollo`
                : `⚠️ #${issue}: rechazado, pero no encontré el ítem`;
        }
        // adjust-definicion
        return transition.ok
            ? `✏️ #${issue} vuelve a definición para ajuste`
            : `⚠️ #${issue}: marcado para ajuste, pero no encontré el ítem`;
    }

    function rejectionToast(reason) {
        switch (reason) {
            case 'unknown-id': return 'Acción inválida o expirada';
            case 'unauthorized': return '🔒 No autorizado para firmar este issue';
            case 'expired': return '⏱️ Acción expirada, pedí el gate de nuevo';
            case 'replayed': return 'Ya firmaste esta acción';
            default: return 'Acción inválida';
        }
    }

    // ---- Orquestación completa de una firma (para el listener) -------------
    /**
     * Procesa un `callback_query` de firma end-to-end (sin I/O de Telegram, que
     * queda en el listener). Devuelve el veredicto + el `toast` a mostrar y si
     * corresponde editar el mensaje (quitar botones, CA-10). SIEMPRE devuelve un
     * `toast` para que el caller responda `answerCallbackQuery` en todos los
     * caminos (CA-9).
     *
     * @param {object} p
     * @param {string|number} p.operatorId — `callback.from.id` (NO chat.id).
     * @param {string} p.callbackData — id opaco del botón.
     * @returns {{ok, toast, transitioned?, editMessage, reason?, action?, issue?}}
     */
    function handleSignature({ operatorId, callbackData } = {}) {
        // 1. Resolver el id opaco → binding server-side (A08).
        const entry = resolve(callbackData);
        if (!entry) {
            return { ok: false, toast: rejectionToast('unknown-id'), editMessage: false, reason: 'unknown-id' };
        }

        // 2. Autorizar POR OPERADOR + binding tenant→operador (A01/A07). El
        //    tenant viene del store server-side, nunca del callback_data.
        if (!isAuthorizedOperator(operatorId, entry.tenant)) {
            // NO consumimos el binding: un no-operador no debe poder invalidar la
            // capability legítima del operador. Tampoco auditamos con datos del
            // atacante (evita ruido/inyección en el chain).
            return { ok: false, toast: rejectionToast('unauthorized'), editMessage: false, reason: 'unauthorized' };
        }

        // 3. Verificar y CONSUMIR el token HMAC (firma + exp + nonce single-use).
        const res = signer.verify(entry.token);
        if (!res.ok) {
            // Token inválido/expirado/replay: consumir el binding para no dejar
            // basura (el token ya no sirve). Sin transición, sin audit de éxito.
            consume(callbackData);
            return { ok: false, toast: rejectionToast(res.reason), editMessage: false, reason: res.reason };
        }

        // 4. Transicionar el gate (A03/A04, anti path-traversal en issue).
        const transition = applyTransition({ issue: res.issue, action: res.action, tenant: entry.tenant });

        // 5. Audit inmutable hash-chained de la firma (A09) — SIEMPRE, incluso si
        //    el ítem no existía (queda constancia de la firma del operador).
        try {
            auditSignature({
                actor: operatorId,
                action: res.action,
                issue: res.issue,
                tenant: entry.tenant,
                gate: transition.gate,
                nonce: res.nonce,
                result: transition.status,
            });
        } catch (_) {
            // El audit no debe tumbar la respuesta al operador, pero SÍ dejamos
            // rastro: si el chain está roto, mejor no-op silencioso que crash.
        }

        // 6. Consumir el binding (belt-and-suspenders sobre el nonce single-use).
        consume(callbackData);

        return {
            ok: true,
            toast: successToast(res.action, res.issue, transition),
            transitioned: transition.ok,
            editMessage: transition.ok,
            action: res.action,
            issue: res.issue,
            transition,
        };
    }

    // ---- Inline keyboard (CA-3: emoji + texto, orden estable) ---------------
    /**
     * Construye el `reply_markup.inline_keyboard` para un ítem en firma. Los
     * `callback_data` son ids opacos ya registrados vía `register()`. Orden
     * estable: Aprobar → Rechazar → (Ajustar). El botón ✏️ sólo en definición.
     */
    function buildInlineKeyboard({ approveId, rejectId, adjustId } = {}) {
        const row = [
            { text: '✅ Aprobar', callback_data: String(approveId) },
            { text: '❌ Rechazar', callback_data: String(rejectId) },
        ];
        if (adjustId) row.push({ text: '✏️ Ajustar', callback_data: String(adjustId) });
        return { inline_keyboard: [row] };
    }

    return {
        isAuthorizedOperator,
        register,
        resolve,
        consume,
        applyTransition,
        auditSignature,
        handleSignature,
        buildInlineKeyboard,
        successToast,
        rejectionToast,
        // paths expuestos para diagnóstico/tests
        storeDir,
        waitingDir,
        approvedDir,
        rejectedDir,
        auditFile,
        operatorAllowlist,
    };
}

// Singleton perezoso (producción).
let _default = null;
function getDefault() {
    if (!_default) _default = createOperatorGate();
    return _default;
}

module.exports = {
    createOperatorGate,
    getDefault,
    resolveOperatorAllowlist,
    isValidTenant,
    GATE_ACTIONS,
    OPAQUE_ID_RE,
    TENANT_RE,
};
