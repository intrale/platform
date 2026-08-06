'use strict';

// =============================================================================
// kernel-audit-evidence.js — #5213 CA-3
//
// Proyección ALLOWLIST + redacción de la evidencia de auditoría de la CMK.
//
// El orden importa y es el punto entero del módulo: se PROYECTA primero y se
// escribe después. Nunca se persiste la respuesta cruda de AWS "para redactarla
// más tarde": un registro de CloudTrail trae `recipientAccountId`,
// `requestID`, `eventID`, ARNs completos y `requestParameters` con contexto de
// cifrado. Una redacción por denylist sobre ese objeto falla abierto ante
// cualquier campo nuevo que AWS agregue; una proyección por allowlist falla
// cerrada (lo que no está listado, no sale).
//
// La segunda capa es `assertRedacted`, que vuelve a escanear el resultado ya
// proyectado y TIRA si encuentra un identificador prohibido. No reemplaza a la
// proyección: la audita. Si las dos capas discrepan, gana el error.
// =============================================================================

const crypto = require('node:crypto');
const { redactSecretValue, shannonEntropy } = require('./redact');

// Lo único que sale de un registro de CloudTrail hacia la evidencia. Todo lo
// demás se descarta por omisión (allowlist, no denylist).
const EVENT_ALLOWLIST = Object.freeze(['eventTime', 'eventName', 'principal',
    'principalExpected', 'invokedBy', 'errorCode', 'outcome']);

// Identificadores que la CA prohíbe explícitamente en la evidencia persistida.
// El nombre es lo que se reporta al fallar; el valor ofensor NUNCA se incluye
// en el mensaje de error (sería filtrarlo por el canal de la excepción).
const FORBIDDEN_PATTERNS = Object.freeze([
    { name: 'arn-completo', re: /arn:aws[a-z0-9-]*:/i },
    { name: 'account-id', re: /(?<!\d)\d{12}(?!\d)/ },
    { name: 'uuid-request-o-event-id', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
    { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'jwt', re: /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
]);

// Un token opaco largo dentro de la evidencia es material criptográfico o un
// identificador que no debería estar ahí. El umbral es el mismo que usa
// `redact.js` para su heurística de entropía.
const OPAQUE_MIN_LEN = 40;
const OPAQUE_ENTROPY_THRESHOLD = 4.5;

/**
 * Reduce un principal a `<tipo>/<nombre>`, sin cuenta ni partición.
 *
 *   arn:aws:iam::123456789012:user/intrale-kernel-runtime → user/intrale-kernel-runtime
 *   arn:aws:sts::123456789012:assumed-role/Rol/sesion     → assumed-role/Rol
 *
 * El nombre de sesión se descarta a propósito: en muchas organizaciones es el
 * mail del operador, o sea PII que no aporta a la correlación.
 */
function redactPrincipal(identity) {
    if (!identity) return null;
    if (typeof identity === 'object') {
        const fromArn = redactPrincipal(identity.arn);
        return fromArn || identity.type || null;
    }
    const arn = String(identity);
    if (!arn.startsWith('arn:')) {
        // IDEMPOTENCIA. `extractCmkUsage` ya proyecta el principal y
        // `projectEvent` vuelve a proyectarlo al construir la evidencia. Sin
        // este paso, la segunda pasada no reconoce `user/intrale-kernel-runtime`
        // —no es un ARN ni un principal de servicio— y devuelve `null`: la
        // evidencia perdía el principal justo en el campo que la CA pide
        // correlacionar. Observado el 2026-08-05 sobre eventos reales del trail.
        if (/^[a-z-]+\/[\w+=,.@-]+$/i.test(arn)) return arn;
        // Principal de servicio (`dynamodb.amazonaws.com`) o tipo suelto.
        return /^[a-z0-9.-]+\.amazonaws\.com$/i.test(arn) || /^[A-Za-z]+$/.test(arn) ? arn : null;
    }
    const tail = arn.split(':').slice(5).join(':');
    const parts = tail.split('/').filter(Boolean);
    if (!parts.length) return null;
    // `user/x`, `role/x`, `assumed-role/Rol` (se corta antes de la sesión).
    return parts.slice(0, 2).join('/');
}

/**
 * Huella estable de la CMK. Permite correlacionar dos evidencias entre sí sin
 * publicar el ARN ni el key id. Es un digest de un identificador público, no un
 * secreto: sirve para comparar, no para reconstruir.
 */
function keyFingerprint(keyArn) {
    if (!keyArn) return null;
    return crypto.createHash('sha256').update(String(keyArn)).digest('hex').slice(0, 12);
}

/** Referencia legible de la clave: alias humano + huella, sin ARN. */
function keyReference(keyArn, alias) {
    return { alias: alias || null, fingerprint: keyFingerprint(keyArn) };
}

/** Reemplaza el account id embebido en nombres de recurso (buckets, prefijos). */
function redactResourceName(name) {
    if (typeof name !== 'string') return name;
    return name.replace(/(?<!\d)\d{12}(?!\d)/g, '<account>');
}

/**
 * Redacta TEXTO LIBRE antes de que entre a la evidencia — típicamente el stderr
 * del AWS CLI, que es la única entrada que no pasa por la proyección allowlist.
 *
 * Sin esto, `assertRedacted` haría abortar el reporte entero por un identificador
 * en un mensaje de error: fallar cerrado está bien como última línea, pero perder
 * la evidencia de diez pruebas negativas porque una traía un key id adentro es
 * un mal intercambio. Se redacta acá y la auditoría queda como red de contención.
 */
function redactFreeText(text) {
    if (typeof text !== 'string') return text;
    return redactSecretValue(text)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[REDACTED:id]')
        .replace(/(?<!\d)\d{12}(?!\d)/g, '<account>');
}

/**
 * Proyecta un evento ya extraído del trail a los campos permitidos.
 * `outcome` es derivado y explícito para que la evidencia sea legible sin
 * interpretar la ausencia de `errorCode`.
 */
function projectEvent(event) {
    const source = event || {};
    const projected = {
        eventTime: source.eventTime || null,
        principal: redactPrincipal(source.principal),
        principalExpected: source.principalExpected === undefined ? null : source.principalExpected,
        invokedBy: source.invokedBy || null,
        errorCode: source.errorCode || null,
        outcome: source.errorCode ? 'denegado' : 'exitoso',
    };
    if (source.eventName) projected.eventName = source.eventName;
    return projected;
}

/** Proyecta el mapa `{ Decrypt: [...], GenerateDataKey: [...] }` completo. */
function projectUsage(usage) {
    const out = {};
    for (const [name, events] of Object.entries(usage || {})) {
        out[name] = (events || []).map(projectEvent);
    }
    return out;
}

/**
 * Proyecta el plan de provisioning para poder imprimirlo. El bucket lleva el
 * account id en el nombre y el trail ARN lo lleva entero: los dos son
 * exactamente lo que la CA prohíbe publicar.
 */
function projectPlan(plan) {
    const source = plan || {};
    return {
        region: source.region || null,
        bucket: redactResourceName(source.bucket),
        trailName: source.trailName || null,
        retentionDays: source.retentionDays === undefined ? null : source.retentionDays,
        selector: source.selector || null,
    };
}

/** Recorre un objeto proyectado y devuelve los hallazgos prohibidos por ruta. */
function findForbidden(value, path = '$', found = []) {
    if (value == null) return found;
    if (typeof value === 'string') {
        for (const { name, re } of FORBIDDEN_PATTERNS) {
            if (re.test(value)) found.push({ path, pattern: name });
        }
        const trimmed = value.trim();
        if (trimmed.length > OPAQUE_MIN_LEN && !/\s/.test(trimmed)
            && shannonEntropy(trimmed) >= OPAQUE_ENTROPY_THRESHOLD) {
            found.push({ path, pattern: 'token-opaco-alta-entropia' });
        }
        return found;
    }
    if (typeof value !== 'object') return found;
    if (Array.isArray(value)) {
        value.forEach((item, index) => findForbidden(item, `${path}[${index}]`, found));
        return found;
    }
    for (const [key, item] of Object.entries(value)) {
        findForbidden(key, `${path}.<clave>`, found);
        findForbidden(item, `${path}.${key}`, found);
    }
    return found;
}

/**
 * Auditoría de la proyección. Tira si sobrevivió un identificador prohibido.
 *
 * El mensaje nombra la RUTA y el PATRÓN, nunca el valor: un error que imprime
 * el ARN que estaba tratando de ocultar filtra por el canal de la excepción, y
 * las excepciones terminan en logs y en el issue.
 */
function assertRedacted(evidence) {
    const found = findForbidden(evidence);
    if (found.length) {
        const detalle = found.map((f) => `${f.path} (${f.pattern})`).join(', ');
        throw new Error(`evidencia con identificadores prohibidos: ${detalle}`);
    }
    return evidence;
}

/**
 * Único punto de construcción de evidencia. Proyecta, redacta como defensa en
 * profundidad y audita antes de devolver. Lo que sale de acá es lo que se puede
 * escribir a disco, imprimir o pegar en un issue.
 */
function buildEvidence({ plan, keyArn, keyAlias, usage, negativeTests, generatedAt } = {}) {
    const evidence = {
        generatedAt: generatedAt || null,
        plan: projectPlan(plan),
        key: keyReference(keyArn, keyAlias),
        usage: projectUsage(usage),
    };
    if (negativeTests) evidence.negativeTests = negativeTests;
    // Defensa en profundidad: la proyección ya debería alcanzar, pero un campo
    // de texto libre (mensaje de error del CLI) puede traer un secreto.
    const scrubbed = JSON.parse(JSON.stringify(evidence), (_key, value) => (
        typeof value === 'string' ? redactSecretValue(value) : value
    ));
    return assertRedacted(scrubbed);
}

module.exports = {
    EVENT_ALLOWLIST, FORBIDDEN_PATTERNS,
    redactPrincipal, keyFingerprint, keyReference, redactResourceName, redactFreeText,
    projectEvent, projectUsage, projectPlan,
    findForbidden, assertRedacted, buildEvidence,
};
