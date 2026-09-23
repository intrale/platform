'use strict';

/**
 * #7634 (parte 1 de #7598) — ERROR TIPADO DEL ENTORNO DE UN AGENTE HIJO.
 *
 * `ChildEnvViolation` lo tira `assertChildEnvMinimal` (build-child-env.js)
 * cuando el env final de un hijo no es el mínimo declarado. Reglas (S6/D5):
 *
 *   - Sólo lleva NOMBRES de variables, rol, fase, intento y el `kind` de la
 *     causa (enum cerrado). Nunca valores, prefijos, largos, hashes ni `***`.
 *   - No guarda el env (ni una parte) como propiedad del error.
 *   - `toJSON()` explícito: `JSON.stringify(err)` sólo serializa
 *     `{ name, code, message, details }`.
 *
 * Formato del mensaje (UX, D6), en este orden fijo:
 *
 *   [entorno-hijo] Lanzamiento bloqueado · rol=<skill> · fase=<fase> · intento=<provider>
 *   Motivo: <frase en español> → NOMBRE_A, NOMBRE_B (<kind>)
 *   ...una línea `Motivo:` por causa...
 *   Cómo seguir: si el rol la necesita, declarar el scope en agent-models.json (requires_credentials). Detalle en docs/pipeline/entorno-agentes-hijos.md.
 *   Ver: docs/pipeline/entorno-agentes-hijos.md#<ancla>
 *
 * Módulo hoja: sólo depende de `credential-sentinel.js` (otro módulo hoja).
 */

const { looksLikeSecret } = require('./credential-sentinel');

const CODE = 'CHILD_ENV_VIOLATION';
const DOC_PATH = 'docs/pipeline/entorno-agentes-hijos.md';
const DEFAULT_ANCHOR = 'lanzaragenteclaude';

/** `kind` → frase humana (UX). Enum cerrado: un kind fuera de esta lista se rechaza. */
const KIND_TEXTO_ES = Object.freeze({
    'undeclared': 'variable no declarada para este rol',
    'reserved-alias': 'credencial reservada bajo otro nombre',
    'case-duplicate': 'la misma variable aparece dos veces con distinta grafía de mayúsculas',
    'unknown-phase': 'fase desconocida',
    'unknown-skill': 'rol sin declaración de entorno',
    'invalid-exception': 'excepción inválida (comodín o credencial reservada)',
    'aws-access-key': 'valor con forma de secreto (clave de AWS) en',
    'github-token': 'valor con forma de secreto (token de GitHub) en',
    'provider-key': 'valor con forma de secreto (key de proveedor) en',
    'telegram-token': 'valor con forma de secreto (token de Telegram) en',
    'jwt': 'valor con forma de secreto (JWT) en',
});

const KINDS = Object.freeze(Object.keys(KIND_TEXTO_ES));

/** Nombre "seguro" para el mensaje: sólo caracteres de nombre de variable, acotado. */
function nombreSeguro(n) {
    const s = String(n);
    // Un NOMBRE con forma de secreto (alguien usó el valor como clave) tampoco se imprime.
    if (looksLikeSecret(s)) return '(nombre con forma de secreto)';
    return /^[A-Za-z0-9_().\-]{1,128}$/.test(s) ? s : '(nombre no imprimible)';
}

function campoSeguro(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    const s = String(v);
    return /^[A-Za-z0-9_.\-()/ ]{1,64}$/.test(s) ? s : '(inválido)';
}

/**
 * Normaliza las causas: agrupa por kind, deduplica y ordena nombres.
 * @param {Array<{kind:string, nombres?:string[]}>} causas
 */
function normalizarCausas(causas) {
    const porKind = new Map();
    for (const c of causas || []) {
        if (!c || !KINDS.includes(c.kind)) {
            throw new TypeError('[child-env-error] causa con kind fuera del enum cerrado KINDS.');
        }
        if (!porKind.has(c.kind)) porKind.set(c.kind, new Set());
        for (const n of c.nombres || []) porKind.get(c.kind).add(nombreSeguro(n));
    }
    const out = [];
    for (const kind of KINDS) {
        if (!porKind.has(kind)) continue;
        out.push(Object.freeze({ kind, nombres: Object.freeze([...porKind.get(kind)].sort()) }));
    }
    return Object.freeze(out);
}

/**
 * @param {{ rol?:string, fase?:string, intento?:string, ancla?:string, causas: Array }} details
 * @returns {string}
 */
function formatChildEnvViolation(details) {
    const d = details || {};
    const lineas = [
        `[entorno-hijo] Lanzamiento bloqueado · rol=${campoSeguro(d.rol, '(ausente)')}`
        + ` · fase=${campoSeguro(d.fase, '(ausente)')}`
        + ` · intento=${campoSeguro(d.intento, '(sin provider)')}`,
    ];
    for (const c of d.causas || []) {
        const nombres = (c.nombres || []).length ? c.nombres.join(', ') : '(sin nombre)';
        const frase = KIND_TEXTO_ES[c.kind];
        // El kind técnico va al final entre paréntesis (grep), sin reemplazar la frase.
        lineas.push(`Motivo: ${frase} → ${nombres} (${c.kind})`);
    }
    lineas.push(
        'Cómo seguir: si el rol la necesita, declarar el scope en agent-models.json '
        + `(requires_credentials). Detalle en ${DOC_PATH}.`,
    );
    lineas.push(`Ver: ${DOC_PATH}#${campoSeguro(d.ancla, DEFAULT_ANCHOR)}`);
    return lineas.join('\n');
}

class ChildEnvViolation extends Error {
    /**
     * @param {{ rol?:string, fase?:string, intento?:string, ancla?:string,
     *           causas: Array<{kind:string, nombres?:string[]}> }} input
     */
    constructor(input = {}) {
        const details = Object.freeze({
            rol: input.rol === undefined ? null : campoSeguro(input.rol, null),
            fase: input.fase === undefined ? null : campoSeguro(input.fase, null),
            intento: input.intento === undefined ? null : campoSeguro(input.intento, null),
            ancla: campoSeguro(input.ancla, DEFAULT_ANCHOR),
            causas: normalizarCausas(input.causas),
        });
        super(formatChildEnvViolation(details));
        this.name = 'ChildEnvViolation';
        this.code = CODE;
        Object.defineProperty(this, 'details', { value: details, enumerable: true });
    }

    toJSON() {
        return { name: this.name, code: this.code, message: this.message, details: this.details };
    }
}

function isChildEnvViolation(e) {
    return !!e && e.code === CODE;
}

module.exports = {
    ChildEnvViolation,
    formatChildEnvViolation,
    isChildEnvViolation,
    CODE,
    KINDS,
    KIND_TEXTO_ES,
    DOC_PATH,
    DEFAULT_ANCHOR,
};
