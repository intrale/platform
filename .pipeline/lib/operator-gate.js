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

// #5458 — Acciones OPERACIONALES. Comparten la capability criptográfica (id
// opaco + HMAC + `exp` corto + nonce single-use) pero NO son acciones de gate:
//   - NO están en `GATE_ACTIONS`, así que `applyTransition()` las rechaza.
//   - NO están en `HUMAN_BLOCK_ACTIONS` ni pasan `isQuickAction()`.
//   - `handleSignature()` las RECHAZA explícitamente (fail-closed): el único
//     camino es `handleOperationalCallback()`, que jamás toca work-files.
// El aislamiento es la razón de ser del split #5458; los tests lo cementan.
const OPERATIONAL_ACTIONS = Object.freeze(['vault-cut-fallback']);

/** Clasifica una acción: 'gate' | 'operational' | null (desconocida). */
function actionKind(action) {
    if (GATE_ACTIONS.includes(action)) return 'gate';
    if (OPERATIONAL_ACTIONS.includes(action)) return 'operational';
    return null;
}

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

    // #5458 — Revalidación de la allowlist AL EJECUTAR. Verificar la firma no
    // alcanza (REQ de `security`, OWASP A01): entre que se publicó el botón y el
    // operador lo toca pueden pasar minutos, y el firmante puede haber sido
    // removido. El resolver se invoca en CADA callback operacional. Por default
    // relee el entorno (fuente única `credentials.js` → env); si el caller
    // inyectó una allowlist explícita, ésa manda (tests herméticos).
    const allowlistResolver = typeof opts.allowlistResolver === 'function'
        ? opts.allowlistResolver
        : (opts.operatorAllowlist ? () => operatorAllowlist : () => resolveOperatorAllowlist());

    // ---- Autorización (A01/A07) --------------------------------------------
    /**
     * Núcleo de autorización contra un allowlist YA resuelto. Fail-closed ante
     * allowlist ausente/vacía o `fromId` nulo.
     */
    function authorizeAgainst(allow, fromId, tenant) {
        if (fromId === null || fromId === undefined) return false;
        const set = allow instanceof Set
            ? allow
            : (Array.isArray(allow) ? new Set(allow.map(String)) : null);
        if (!set || set.size === 0) return false;
        const id = String(fromId);
        if (!set.has(id)) return false;
        if (tenant !== null && tenant !== undefined && tenant !== '') {
            const bound = tenantBinding[String(tenant)];
            if (Array.isArray(bound) && bound.length > 0) {
                return bound.map(String).includes(id);
            }
        }
        return true;
    }

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
        return authorizeAgainst(operatorAllowlist, fromId, tenant);
    }

    /**
     * Igual que `isAuthorizedOperator`, pero RE-RESOLVIENDO la allowlist en el
     * instante de la ejecución (#5458). Un resolver que explota se trata como
     * "no autorizado" — nunca fail-open.
     */
    function isAuthorizedOperatorNow(fromId, tenant) {
        let allow;
        try { allow = allowlistResolver(); } catch { return false; }
        return authorizeAgainst(allow, fromId, tenant);
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
     * @returns {{id, callbackData, token, kind}} — `id`/`callbackData` van al
     *   botón; `kind` es 'gate' | 'operational' (#5458).
     * @throws si issue/action/tenant son inválidos (inputs no confiables).
     */
    function register({ issue, action, tenant = null } = {}) {
        const i = Number(issue);
        if (!isValidIssue(i)) throw new Error(`operator-gate.register: issue inválido (${issue})`);
        // #5458 — se aceptan acciones de gate Y operacionales; el `kind` queda
        // PERSISTIDO server-side para que el despacho no lo tenga que adivinar
        // desde el `callback_data` (que es client-controlled).
        const kind = actionKind(action);
        if (!kind) throw new Error(`operator-gate.register: action inválida (${action})`);
        if (!isValidTenant(tenant)) throw new Error(`operator-gate.register: tenant inválido (${tenant})`);

        const token = signer.sign({ issue: i, action });
        const id = crypto.randomBytes(8).toString('hex'); // 16 hex chars ≤ 64B
        const entry = {
            id, token, issue: i, action, kind,
            tenant: tenant || null,
            created_at: new Date(now()).toISOString(),
        };
        const file = storePathFor(id);
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* idempotente */ }
        _fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
        return { id, callbackData: id, token, kind };
    }

    /**
     * #5458 — Clasifica un `callback_data` SIN consumir nada, resolviendo el
     * binding server-side. El listener lo usa para derivar los callbacks
     * operacionales a su handler dedicado ANTES del gate de lifecycle.
     * @returns {'gate'|'operational'|null} — null si el id es desconocido o la
     *   acción persistida no está en ninguna allowlist (fail-closed).
     */
    function classifyCallback(callbackData) {
        const entry = resolve(callbackData);
        if (!entry) return null;
        // El `kind` persistido manda, pero se revalida contra la allowlist viva:
        // un store manipulado no puede inventar una clase de acción.
        const derived = actionKind(entry.action);
        if (!derived) return null;
        if (entry.kind && entry.kind !== derived) return null;
        return derived;
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

    function rollbackTransition(transition) {
        if (!transition || !transition.ok || !transition.from || !transition.to) return false;
        try {
            if (_fs.existsSync(transition.to) && !_fs.existsSync(transition.from)) {
                _fs.mkdirSync(path.dirname(transition.from), { recursive: true });
                _fs.renameSync(transition.to, transition.from);
                return true;
            }
        } catch (_) {
            return false;
        }
        return false;
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

        // 1.bis #5458 — AISLAMIENTO DEL LIFECYCLE. Una acción operacional jamás
        //    puede atravesar este handler: acá abajo vive `applyTransition()`,
        //    que mueve work-files. Fail-closed y sin consumir el binding (la
        //    capability sigue siendo válida para su handler dedicado).
        if (actionKind(entry.action) !== 'gate') {
            return {
                ok: false,
                toast: rejectionToast('unknown-id'),
                editMessage: false,
                reason: 'not-a-gate-action',
            };
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
        try {
            auditSignature({
                actor: operatorId,
                action: res.action,
                issue: res.issue,
                tenant: entry.tenant,
                gate: null,
                nonce: res.nonce,
                result: 'accepted-before-transition',
            });
        } catch (_) {
            return {
                ok: false,
                toast: 'No se pudo registrar la firma; no se transiciono el gate',
                editMessage: false,
                reason: 'audit-failed',
            };
        }

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
            rollbackTransition(transition);
            return {
                ok: false,
                toast: 'No se pudo registrar la firma; no se transiciono el gate',
                editMessage: false,
                reason: 'audit-failed',
            };
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

    // =========================================================================
    // #5458 — DESPACHO OPERACIONAL AISLADO
    // -------------------------------------------------------------------------
    // Camino ÚNICO de las acciones de `OPERATIONAL_ACTIONS`. Comparte con el
    // canal de firma la capability (id opaco → token HMAC → nonce single-use
    // atómico) y el audit hash-chained, pero NO comparte el ejecutor: acá no se
    // invoca `applyTransition()`, no se mueve ni un work-file y no existe el
    // toast/gate `ajuste-definicion`.
    //
    // El efecto real (persistir `vault.bootstrap_fallback: false`) NO vive en
    // este módulo: se delega a un `executor` inyectable (#5459). Si no hay
    // ejecutor disponible, el corte NO ocurre y el fallback se conserva —
    // fail-closed, que es exactamente el default seguro.
    // =========================================================================

    /** Copy terminal y saneado. Nunca incluye token, nonce, chat id ni paths. */
    function operationalToast(status, action) {
        const nombre = action === 'vault-cut-fallback' ? 'corte del fallback' : 'la acción';
        switch (status) {
            case 'cut':          return `✅ Confirmado — ${nombre} aplicado`;
            case 'already-cut':  return `✅ Ya estaba aplicado — ${nombre} sin cambios`;
            case 'unknown-id':   return 'Acción inválida o expirada';
            case 'unauthorized': return '🔒 No autorizado para confirmar esta acción';
            case 'expired':      return '⏱️ Acción expirada, pedí la confirmación de nuevo';
            case 'replayed':     return 'Ya confirmaste esta acción';
            case 'unavailable':  return '🔒 No se pudo confirmar de forma segura; el fallback se conserva';
            case 'executor-unavailable':
                return '🔒 Ejecutor no disponible; el fallback se conserva';
            case 'precondition-failed':
                return '🔒 Las condiciones del corte ya no se cumplen; el fallback se conserva';
            case 'audit-failed':
                return '🔒 No se pudo registrar la confirmación; no se ejecutó nada';
            default:             return '🔒 No se pudo confirmar; el fallback se conserva';
        }
    }

    /**
     * Procesa un `callback_query` de una acción OPERACIONAL end-to-end (sin I/O
     * de Telegram). SIEMPRE devuelve `toast` para que el caller cierre el
     * `answerCallbackQuery` en todos los caminos.
     *
     * @param {object} p
     * @param {string|number} p.operatorId  `callback.from.id` (NO chat.id).
     * @param {string}   p.callbackData     id opaco del botón.
     * @param {function} [p.executor]       ejecutor del efecto operacional.
     *   Recibe `{ issue, action, operatorId, nonce }` y devuelve
     *   `{ ok, status }` (`status`: 'cut' | 'already-cut' | 'precondition-failed' | ...).
     * @returns {{ok, toast, editMessage, reason, action, issue, status}}
     */
    function handleOperationalCallback({ operatorId, callbackData, executor } = {}) {
        // 1. Resolver el id opaco → binding server-side (A08).
        const entry = resolve(callbackData);
        if (!entry) {
            return { ok: false, toast: operationalToast('unknown-id'), editMessage: false, reason: 'unknown-id' };
        }

        // 2. Sólo acciones operacionales. Un binding de gate que llegue acá se
        //    rechaza sin consumir: su camino es `handleSignature()`.
        if (actionKind(entry.action) !== 'operational') {
            return {
                ok: false,
                toast: operationalToast('unknown-id'),
                editMessage: false,
                reason: 'not-an-operational-action',
            };
        }
        const action = entry.action;

        // 3. Autorizar RE-RESOLVIENDO la allowlist ahora (A01): firmante removido
        //    entre la publicación del botón y el toque ⇒ no autorizado. No se
        //    consume el binding: un no-operador no debe poder quemar la
        //    capability legítima del operador.
        if (!isAuthorizedOperatorNow(operatorId, entry.tenant)) {
            return {
                ok: false, toast: operationalToast('unauthorized', action),
                editMessage: false, reason: 'unauthorized',
            };
        }

        // 4. Verificar y CONSUMIR el token HMAC (firma + `exp` corto + nonce
        //    single-use atómico). `unavailable` = no se pudo decidir el claim:
        //    fail-closed, y sin consumir el binding para permitir un reintento.
        let res;
        try {
            res = signer.verify(entry.token);
        } catch (_) {
            return {
                ok: false, toast: operationalToast('unavailable', action),
                editMessage: false, reason: 'unavailable',
            };
        }

        if (!res.ok) {
            if (res.reason === 'unavailable') {
                return {
                    ok: false, toast: operationalToast('unavailable', action),
                    editMessage: false, reason: 'unavailable',
                };
            }
            consume(callbackData);
            return {
                ok: false, toast: operationalToast(res.reason, action),
                editMessage: true, reason: res.reason,
            };
        }

        // 5. Binding íntegro (A08): la acción y el issue EJECUTADOS salen del
        //    token verificado y deben coincidir con el binding server-side. Una
        //    acción alterada en el store no puede redirigir el efecto.
        if (res.action !== action || Number(res.issue) !== Number(entry.issue)) {
            consume(callbackData);
            return {
                ok: false, toast: operationalToast('unavailable', action),
                editMessage: false, reason: 'binding-mismatch',
            };
        }

        // 6. Audit ANTES del efecto: si no podemos dejar constancia, no se
        //    ejecuta nada (A09).
        try {
            auditSignature({
                actor: operatorId, action: res.action, issue: res.issue,
                tenant: entry.tenant, gate: null, nonce: res.nonce,
                result: 'accepted-before-operational-execution',
            });
        } catch (_) {
            return {
                ok: false, toast: operationalToast('audit-failed', action),
                editMessage: false, reason: 'audit-failed',
            };
        }

        // 7. Efecto operacional. NUNCA `applyTransition()`.
        const run = typeof executor === 'function' ? executor : opts.operationalExecutor;
        let outcome;
        if (typeof run !== 'function') {
            outcome = { ok: false, status: 'executor-unavailable' };
        } else {
            try {
                outcome = run({
                    issue: res.issue, action: res.action,
                    operatorId, nonce: res.nonce, tenant: entry.tenant || null,
                }) || { ok: false, status: 'unavailable' };
            } catch (_) {
                // El detalle del error NO se propaga al toast (A09): puede traer
                // paths, ARNs o hostnames.
                outcome = { ok: false, status: 'unavailable' };
            }
        }

        const status = (typeof outcome.status === 'string' && outcome.status)
            ? outcome.status
            : (outcome.ok ? 'cut' : 'unavailable');

        // 8. Audit del resultado (A09) — siempre, éxito o fallo.
        try {
            auditSignature({
                actor: operatorId, action: res.action, issue: res.issue,
                tenant: entry.tenant, gate: null, nonce: res.nonce,
                result: status,
            });
        } catch (_) { /* el efecto ya ocurrió: no se puede deshacer acá */ }

        // 9. Consumir el binding: la respuesta es TERMINAL (el nonce ya se gastó,
        //    un segundo toque nunca puede repetir el efecto).
        consume(callbackData);

        return {
            ok: !!outcome.ok,
            toast: operationalToast(status, action),
            editMessage: true,
            action: res.action,
            issue: res.issue,
            status,
            reason: outcome.ok ? null : status,
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
        isAuthorizedOperatorNow,
        register,
        resolve,
        consume,
        applyTransition,
        auditSignature,
        handleSignature,
        // #5458 — despacho operacional aislado del lifecycle.
        classifyCallback,
        handleOperationalCallback,
        operationalToast,
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
    // #5458 — vocabulario único de acciones operacionales. Se importa, nunca se
    // copia: una segunda lista literal se desincroniza del aislamiento.
    OPERATIONAL_ACTIONS,
    actionKind,
    OPAQUE_ID_RE,
    TENANT_RE,
};
