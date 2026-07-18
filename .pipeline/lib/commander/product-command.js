// =============================================================================
// product-command.js — Núcleo product-aware del Telegram Commander
// Issue #4780 (Ola Puente P6, split de #4691 §4.7).
//
// QUÉ RESUELVE
// ------------
// Mapea texto NL → intent contra una ALLOWLIST CERRADA fail-closed de
// `{comando × producto}` restringida a lo autorizado para el `from.id`, con
// confirmación explícita anti-TOCTOU para acciones destructivas y rechazo
// uniforme sin fuga de información. Es un módulo PURO/determinístico
// (unit-testeable sin levantar el pulpo).
//
// FRONTERAS DE SEGURIDAD (SR-1..7 de `security`/`guru` — CA no negociables)
// -------------------------------------------------------------------------
// [SR-4/A03] `handoff.detectInjection(text)` ANTES de mapear a intent. El
//   resultado del parser NUNCA amplía el set de productos ni de comandos: el NL
//   sólo puede SELECCIONAR DENTRO de lo ya autorizado para ese `from.id`. La
//   autz es la frontera dura; el NL vive adentro. Cuantificadores de amplitud
//   ("todos los productos", "todo") → rechazo (no "mejor esfuerzo").
// [SR-1/A07] Autz por `from.id` vía `product-registry.isAuthorized` (no
//   `chat.id`). Cualquier intent sobre un producto no autorizado → rechazo.
// [SR-2/A04] Confirmación destructiva: el `productId` se EMBEBE server-side en
//   un nonce opaco (`register`). Al confirmar, el producto se resuelve DESDE el
//   nonce — `confirm()` NO acepta ningún producto del segundo mensaje. Un
//   atacante que pida confirmación sobre A y mande "B" en el 2º mensaje ejecuta
//   A o falla, jamás B (confused-deputy imposible por construcción).
// [SR-3] `destructive-cooldown.js` es UX (pulsado accidental), NO defensa: la
//   confirmación explícita + allowlist cerrada + detectInjection son la defensa.
// [SR-5/A01] Rechazo UNIFORME: "no autorizado" y "no existe" son indistinguibles
//   (mismo texto), sin filtrar nombres/cantidad/estado de productos ajenos.
// [SR-6] Sin `productId` → producto default (Intrale) con authz validada, nunca
//   wildcard. Pedir explícitamente otro producto no autorizado → rechazo.
// [SR-7/A09] Cada acción se asienta en el audit tamper-evident hash-chained
//   (`createProductAudit`): actor + productId + origen=telegram + action +
//   result.
// =============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { detectInjection } = require('../handoff');

// -----------------------------------------------------------------------------
// Allowlist CERRADA de comandos (SR-4). Congelada: el parser jamás produce un
// comando fuera de este set. `destructive:true` exige confirmación explícita.
// Los `keywords` son las formas NL (ES) que mapean a cada comando. El match es
// por palabra-límite, case-insensitive, sin acentos.
// -----------------------------------------------------------------------------
const COMMANDS = Object.freeze({
    status: {
        destructive: false,
        keywords: ['estado', 'status', 'como va', 'como esta', 'situacion'],
    },
    pause: {
        destructive: true,
        keywords: ['pausa', 'pausar', 'pausame', 'frena', 'frenar', 'detene', 'detener'],
    },
    resume: {
        destructive: true,
        keywords: ['reanuda', 'reanudar', 'segui', 'seguir', 'continua', 'continuar', 'despausar', 'despausa'],
    },
    approve: {
        destructive: true,
        keywords: ['aproba', 'aprobar', 'aprueba', 'aprobame'],
    },
    reject: {
        destructive: true,
        keywords: ['rechaza', 'rechazar', 'rechazame'],
    },
    sign: {
        destructive: true,
        keywords: ['firma', 'firmar', 'firmame'],
    },
});

const COMMAND_IDS = Object.freeze(Object.keys(COMMANDS));

// Palabras conectivas neutras que se descartan al detectar si el mensaje nombra
// un producto. NO son designadores de producto: sirven para que "pausá el
// pipeline" (sin producto) resuelva al default sin gatillar un rechazo espurio.
const STOPWORDS = Object.freeze(new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'de', 'del', 'al', 'a', 'en', 'por', 'para', 'con', 'y', 'e', 'o', 'u',
    'favor', 'porfa', 'pf', 'dale', 'ahora', 'ya', 'porfavor',
    'pipeline', 'producto', 'proyecto', 'sistema', 'todo', 'esto', 'eso',
    'me', 'te', 'lo', 'su', 'mi', 'que',
]));

// Cuantificadores de AMPLITUD que intentan ensanchar el scope más allá de un
// único producto autorizado (SR-4). Cualquier match → rechazo fail-closed.
const SCOPE_WIDENING_RE = /\b(todos?\s+los\s+productos?|todos?\s+los\s+pipelines?|todo\s+el\s+pipeline|cada\s+producto|all\s+products?|everything|todos?\b)\b/i;

// Rechazo UNIFORME (SR-5). Mismo texto para "no autorizado" y "no existe" — el
// cliente no puede distinguir ni enumerar productos ajenos.
const UNIFORM_REJECT = 'No tenés permisos para operar ese producto.';

// El id opaco del nonce de confirmación: hex 32 chars (16 bytes). Validado como
// nombre de archivo (anti path-traversal: sólo [a-f0-9]).
const NONCE_ID_RE = /^[a-f0-9]{32}$/;

// TTL por default del nonce de confirmación (5 min). Pasado ese lapso, la
// confirmación caduca (evita ventanas TOCTOU largas).
const DEFAULT_CONFIRM_TTL_MS = 5 * 60 * 1000;

/**
 * Normaliza texto para el match de keywords: minúsculas + sin acentos +
 * colapsa espacios. NO altera el texto original (que va al detectInjection y al
 * audit); es sólo para clasificar.
 */
function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // quita diacríticos combinantes
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match de una frase (posible multi-palabra) como secuencia de tokens con
 *  límites de palabra dentro de `normText`. */
function phraseMatches(normText, phrase) {
    const re = new RegExp(`(^|\\s)${escapeRe(phrase)}(\\s|$)`);
    return re.test(normText);
}

/**
 * Mapea texto normalizado → comando de la allowlist cerrada, o `null` si ningún
 * keyword matchea (fail-closed: intent no reconocido = rechazo). Si matchean
 * varios comandos (ambigüedad), devuelve `null` — no adivina.
 */
function classifyCommand(normText) {
    const matched = new Set();
    for (const id of COMMAND_IDS) {
        for (const kw of COMMANDS[id].keywords) {
            if (phraseMatches(normText, kw)) { matched.add(id); break; }
        }
    }
    if (matched.size !== 1) return null; // 0 = desconocido, >1 = ambiguo
    return [...matched][0];
}

/** Conjunto de tokens que forman los keywords del comando dado (para poder
 *  descartarlos al buscar designadores de producto residuales). */
function commandKeywordTokens(command) {
    const set = new Set();
    for (const kw of COMMANDS[command].keywords) {
        for (const t of kw.split(/\s+/)) set.add(t);
    }
    return set;
}

/**
 * Tokens residuales del mensaje que podrían designar un producto: se sacan los
 * tokens del comando y las stopwords conectivas. Si queda algo, el usuario
 * nombró "algo" que se interpreta como producto (autorizado o no). Vacío ⇒ no
 * nombró producto ⇒ aplica el default (SR-6).
 */
function residualProductTokens(normText, command) {
    const cmdTokens = commandKeywordTokens(command);
    return normText
        .split(' ')
        .filter((t) => t.length > 0 && !cmdTokens.has(t) && !STOPWORDS.has(t));
}

/**
 * Crea el commander product-aware.
 *
 * @param {object} opts
 * @param {object} opts.registry   product-registry (isAuthorized/resolveProduct/…).
 * @param {object} opts.audit      recorder de createProductAudit ({ record }).
 * @param {string} [opts.storeDir] dir del store de nonces de confirmación.
 * @param {number} [opts.confirmTtlMs] TTL del nonce (default 5 min).
 * @param {function} [opts.now]    clock inyectable.
 * @param {object} [opts.fsImpl]   fs inyectable (tests).
 * @param {function} [opts.pick]   selector de variante de copy (default: rota por hash).
 */
function createProductCommander(opts = {}) {
    const registry = opts.registry;
    if (!registry || typeof registry.isAuthorized !== 'function') {
        throw new Error('product-command: opts.registry es obligatorio');
    }
    const audit = opts.audit && typeof opts.audit.record === 'function' ? opts.audit : null;
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const confirmTtlMs = Number.isFinite(opts.confirmTtlMs) && opts.confirmTtlMs > 0
        ? opts.confirmTtlMs
        : DEFAULT_CONFIRM_TTL_MS;
    const storeDir = opts.storeDir
        || path.join(__dirname, '..', '..', 'operator-gate', 'product-confirm');

    function auditRecord(rec) {
        if (!audit) return;
        try { audit.record(rec); } catch (_) { /* audit no debe romper el commander */ }
    }

    // ---- Store opaco de confirmaciones (SR-2, anti-TOCTOU) -----------------
    function noncePathFor(id) {
        if (typeof id !== 'string' || !NONCE_ID_RE.test(id)) return null;
        const file = path.join(storeDir, `${id}.json`);
        const resolved = path.resolve(file);
        if (!resolved.startsWith(path.resolve(storeDir) + path.sep)) return null;
        return resolved;
    }

    /**
     * Registra una confirmación pendiente: embebe {fromId, productId, command}
     * server-side en un nonce opaco. El `productId` NO viaja al cliente como
     * dato de confianza; sólo se persiste acá y se recupera en `confirm`.
     */
    function registerConfirmation({ fromId, productId, command }) {
        const id = crypto.randomBytes(16).toString('hex');
        const entry = {
            id,
            from_id: String(fromId),
            product_id: productId,   // fuente de verdad del producto (SR-2)
            command,
            created_at: new Date(now()).toISOString(),
            expires_at: now() + confirmTtlMs,
        };
        const file = noncePathFor(id);
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* idempotente */ }
        _fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
        return id;
    }

    function resolveConfirmation(id) {
        const file = noncePathFor(id);
        if (!file) return null;
        try {
            return JSON.parse(_fs.readFileSync(file, 'utf8'));
        } catch { return null; }
    }

    function consumeConfirmation(id) {
        const file = noncePathFor(id);
        if (!file) return;
        try { _fs.unlinkSync(file); } catch { /* ya consumido */ }
    }

    // ---- Copy natural nombrando SIEMPRE el producto (UX-1/UX-2) ------------
    function pickVariant(variants, seed) {
        if (typeof opts.pick === 'function') return opts.pick(variants, seed);
        // Determinístico sin Math.random: rota por hash del seed.
        const h = crypto.createHash('sha256').update(String(seed)).digest();
        return variants[h[0] % variants.length];
    }

    function actionDoneCopy(command, productName) {
        const p = `*${productName}*`;
        const byCmd = {
            pause: [`Pausé ${p}. Frené el dispatch de agentes.`, `Listo, ${p} queda en pausa.`],
            resume: [`Reanudé ${p}. Vuelve a despachar agentes.`, `${p} otra vez en marcha.`],
            approve: [`Aprobé ${p}.`, `Dado el OK sobre ${p}.`],
            reject: [`Rechacé lo pendiente de ${p}.`, `Marqué el rechazo en ${p}.`],
            sign: [`Firmé el gate de ${p}.`, `Firma aplicada sobre ${p}.`],
            status: [`Estado de ${p} a continuación.`],
        };
        const variants = byCmd[command] || [`Acción aplicada sobre ${p}.`];
        return pickVariant(variants, `${command}:${productName}`);
    }

    function confirmPromptCopy(command, productName) {
        const p = `*${productName}*`;
        const byCmd = {
            pause: `¿Confirmás que pause ${p}? Esto frena el dispatch de agentes.`,
            resume: `¿Confirmás que reanude ${p}?`,
            approve: `¿Confirmás la aprobación sobre ${p}?`,
            reject: `¿Confirmás el rechazo sobre ${p}?`,
            sign: `¿Confirmás la firma del gate de ${p}?`,
        };
        return byCmd[command] || `¿Confirmás la acción sobre ${p}?`;
    }

    /**
     * Parsea un mensaje NL a intent product-aware. Fail-closed en todo camino
     * ambiguo. NO ejecuta nada — sólo clasifica y (para destructivos) registra
     * el nonce de confirmación.
     *
     * @param {object} p
     * @param {string} p.text            texto crudo del mensaje.
     * @param {string|number} p.fromId   identidad del operador (msg.from.id).
     * @param {string} [p.productId]     productId EXPLÍCITO de un canal confiable
     *                                   (normalmente ausente; el producto se
     *                                   deriva del texto+authz, nunca "de
     *                                   confianza" del texto).
     * @returns {object} uno de:
     *   { ok:false, reason, response }                              (rechazo uniforme)
     *   { ok:true, command, productId, productName, needsConfirmation:false, response }
     *   { ok:true, command, productId, productName, needsConfirmation:true, confirmId, response }
     */
    function parse({ text, fromId, productId } = {}) {
        const raw = String(text || '');

        // 1) Anti prompt-injection (SR-4) — ANTES de cualquier mapeo.
        const inj = detectInjection(raw);
        if (inj.hits && inj.hits.length > 0) {
            auditRecord({ actor: fromId, productId: null, action: 'nl-parse', result: 'injection' });
            return { ok: false, reason: 'rejected', response: UNIFORM_REJECT };
        }

        const norm = normalizeText(raw);

        // 2) Rechazo de cuantificadores de amplitud (SR-4): "todos los productos".
        if (SCOPE_WIDENING_RE.test(norm)) {
            auditRecord({ actor: fromId, productId: null, action: 'nl-parse', result: 'scope-widening' });
            return { ok: false, reason: 'rejected', response: UNIFORM_REJECT };
        }

        // 3) Mapeo a comando de la allowlist cerrada (fail-closed).
        const command = classifyCommand(norm);
        if (!command) {
            auditRecord({ actor: fromId, productId: null, action: 'nl-parse', result: 'unknown-command' });
            return { ok: false, reason: 'rejected', response: UNIFORM_REJECT };
        }

        // 4) Resolver el producto objetivo — SÓLO dentro de lo autorizado para
        //    el from.id (el NL selecciona adentro, nunca amplía — SR-4).
        const authorized = registry.listProductsFor(fromId); // [{productId,name}]
        let targetProductId = null;

        if (productId) {
            // productId explícito de un canal confiable (raro en NL directo).
            targetProductId = registry.resolveProduct(productId);
        } else {
            // (a) ¿el texto menciona un producto AUTORIZADO (por id o nombre)?
            //     Sólo se busca contra los productos del operador → sin oráculo
            //     de enumeración (SR-5).
            for (const prod of authorized) {
                if (phraseMatches(norm, prod.productId.toLowerCase())
                    || phraseMatches(norm, prod.name.toLowerCase())) {
                    targetProductId = prod.productId;
                    break;
                }
            }
            if (!targetProductId) {
                // (b) No matcheó ningún producto autorizado. ¿El usuario nombró
                //     ALGÚN producto (token residual tras sacar comando +
                //     stopwords)? Si sí, es un producto NO autorizado o
                //     inexistente → rechazo uniforme (SR-5, indistinguible).
                //     NUNCA caemos al default cuando el usuario nombró otra cosa:
                //     eso ejecutaría sobre el producto equivocado (grave).
                const residual = residualProductTokens(norm, command);
                if (residual.length > 0) {
                    auditRecord({ actor: fromId, productId: null, action: command, result: 'rejected' });
                    return { ok: false, reason: 'rejected', response: UNIFORM_REJECT };
                }
                // (c) Sin producto nombrado → default (SR-6), con authz validada
                //     abajo (nunca wildcard).
                targetProductId = registry.resolveProduct(null);
            }
        }

        // 5) Frontera dura de autz (SR-1). Producto inexistente/no-autorizado →
        //    rechazo uniforme (indistinguible — SR-5).
        if (!registry.isAuthorized(fromId, targetProductId)) {
            auditRecord({ actor: fromId, productId: targetProductId || null, action: command, result: 'rejected' });
            return { ok: false, reason: 'rejected', response: UNIFORM_REJECT };
        }

        const productName = registry.productName(targetProductId);

        // 6) Destructivo → exige confirmación explícita con producto bindeado.
        if (COMMANDS[command].destructive) {
            const confirmId = registerConfirmation({ fromId, productId: targetProductId, command });
            auditRecord({ actor: fromId, productId: targetProductId, action: command, result: 'confirm-requested' });
            return {
                ok: true,
                command,
                productId: targetProductId,
                productName,
                needsConfirmation: true,
                confirmId,
                response: confirmPromptCopy(command, productName),
            };
        }

        // 7) No destructivo → resultado directo.
        auditRecord({ actor: fromId, productId: targetProductId, action: command, result: 'ok' });
        return {
            ok: true,
            command,
            productId: targetProductId,
            productName,
            needsConfirmation: false,
            response: actionDoneCopy(command, productName),
        };
    }

    /**
     * Confirma una acción destructiva pendiente. El producto se resuelve DESDE
     * el nonce server-side (SR-2) — esta función NO acepta ningún productId del
     * segundo mensaje: es imposible ejecutar sobre un producto distinto al
     * registrado. Single-use: el nonce se consume siempre.
     *
     * @param {object} p
     * @param {string|number} p.fromId   identidad de quien confirma (msg.from.id).
     * @param {string} p.confirmId       nonce opaco devuelto por `parse`.
     * @returns {object}
     *   { ok:false, reason, response }
     *   { ok:true, command, productId, productName, response }
     */
    function confirm({ fromId, confirmId } = {}) {
        const entry = resolveConfirmation(confirmId);
        if (!entry) {
            return { ok: false, reason: 'unknown-or-expired', response: 'Esa confirmación no es válida o ya venció.' };
        }

        // El productId es EXCLUSIVAMENTE el del nonce (SR-2). Nunca se re-parsea.
        const productId = entry.product_id;
        const command = entry.command;

        // Caducidad del nonce.
        if (!Number.isFinite(entry.expires_at) || now() > entry.expires_at) {
            consumeConfirmation(confirmId);
            auditRecord({ actor: fromId, productId, action: command, result: 'confirm-expired' });
            return { ok: false, reason: 'expired', response: 'Esa confirmación ya venció, pedila de nuevo.' };
        }

        // El que confirma debe ser el MISMO operador que la solicitó, y seguir
        // autorizado sobre el producto (defensa en profundidad, SR-1).
        if (String(fromId) !== String(entry.from_id) || !registry.isAuthorized(fromId, productId)) {
            // NO consumimos: un tercero no debe invalidar la confirmación legítima.
            auditRecord({ actor: fromId, productId, action: command, result: 'rejected' });
            return { ok: false, reason: 'rejected', response: UNIFORM_REJECT };
        }

        // Single-use: consumir antes de ejecutar (idempotencia anti doble-tap).
        consumeConfirmation(confirmId);

        const productName = registry.productName(productId);
        auditRecord({ actor: fromId, productId, action: command, result: 'ok' });
        return {
            ok: true,
            command,
            productId,
            productName,
            response: actionDoneCopy(command, productName),
        };
    }

    return {
        parse,
        confirm,
        // expuestos para diagnóstico/tests
        _registerConfirmation: registerConfirmation,
        _resolveConfirmation: resolveConfirmation,
        storeDir,
    };
}

module.exports = {
    createProductCommander,
    classifyCommand,
    normalizeText,
    COMMANDS,
    COMMAND_IDS,
    UNIFORM_REJECT,
    SCOPE_WIDENING_RE,
    NONCE_ID_RE,
    DEFAULT_CONFIRM_TTL_MS,
};
