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
 * #7635 — kind `expired-exception`: una variable cubierta SÓLO por una excepción
 * vencida de `.pipeline/env-exceptions.yaml`. La causa puede traer
 * `vencimientos: [{ nombre, revisar_el, aprobador }]`; al mensaje van SÓLO la
 * fecha (revalidada ISO) y el aprobador (revalidado contra
 * `^@?[A-Za-z0-9-]{1,39}$`; si no, `desconocido`). El `fundamento` del YAML
 * nunca llega a este módulo (SEC-5).
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
    'expired-exception': 'excepción vencida (requiere revisión humana)',
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

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const APROBADOR = /^@?[A-Za-z0-9-]{1,39}$/;

function fechaSegura(v) {
    if (typeof v !== 'string' || !ISO_FECHA.test(v)) return '(fecha inválida)';
    const d = new Date(v + 'T00:00:00Z');
    return (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v) ? v : '(fecha inválida)';
}

const APROBADOR_DESCONOCIDO = 'desconocido';

function aprobadorSeguro(v) {
    // Idempotente: el formateador puede recibir vencimientos ya saneados.
    if (v === APROBADOR_DESCONOCIDO) return APROBADOR_DESCONOCIDO;
    if (typeof v !== 'string' || !APROBADOR.test(v)) return APROBADOR_DESCONOCIDO;
    return v.startsWith('@') ? v : '@' + v;
}

/** #7635 — vencimientos saneados: sólo nombre, fecha ISO y aprobador revalidados. */
function normalizarVencimientos(lista) {
    const vistos = new Map();
    for (const v of Array.isArray(lista) ? lista : []) {
        if (!v || typeof v !== 'object') continue;
        const item = Object.freeze({
            nombre: nombreSeguro(v.nombre),
            revisar_el: fechaSegura(v.revisar_el),
            aprobador: aprobadorSeguro(v.aprobador),
        });
        vistos.set(`${item.nombre}|${item.revisar_el}|${item.aprobador}`, item);
    }
    return Object.freeze([...vistos.keys()].sort().map((k) => vistos.get(k)));
}

/**
 * Normaliza las causas: agrupa por kind, deduplica y ordena nombres.
 * @param {Array<{kind:string, nombres?:string[], vencimientos?:Array}>} causas
 */
function normalizarCausas(causas) {
    const porKind = new Map();
    const vencimientos = [];
    for (const c of causas || []) {
        if (!c || !KINDS.includes(c.kind)) {
            throw new TypeError('[child-env-error] causa con kind fuera del enum cerrado KINDS.');
        }
        if (!porKind.has(c.kind)) porKind.set(c.kind, new Set());
        for (const n of c.nombres || []) porKind.get(c.kind).add(nombreSeguro(n));
        if (c.kind === 'expired-exception' && Array.isArray(c.vencimientos)) vencimientos.push(...c.vencimientos);
    }
    const out = [];
    for (const kind of KINDS) {
        if (!porKind.has(kind)) continue;
        const causa = { kind, nombres: Object.freeze([...porKind.get(kind)].sort()) };
        if (kind === 'expired-exception' && vencimientos.length) {
            causa.vencimientos = normalizarVencimientos(vencimientos);
        }
        out.push(Object.freeze(causa));
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
    let hayVencidas = false;
    for (const c of d.causas || []) {
        const frase = KIND_TEXTO_ES[c.kind];
        if (c.kind === 'expired-exception' && Array.isArray(c.vencimientos) && c.vencimientos.length) {
            // #7635 — una línea por vencimiento: qué, desde cuándo y a quién preguntar (UX).
            hayVencidas = true;
            for (const v of normalizarVencimientos(c.vencimientos)) {
                lineas.push(`Motivo: ${frase} → ${v.nombre} · venció el ${v.revisar_el}`
                    + ` · aprobó ${v.aprobador} (${c.kind})`);
            }
            continue;
        }
        const nombres = (c.nombres || []).length ? c.nombres.join(', ') : '(sin nombre)';
        // El kind técnico va al final entre paréntesis (grep), sin reemplazar la frase.
        lineas.push(`Motivo: ${frase} → ${nombres} (${c.kind})`);
    }
    if (hayVencidas) {
        lineas.push(
            'Cómo seguir (excepción vencida): renovar revisar_el con un PR que el operador '
            + 'revise y mergee a mano (gate de permisos).',
        );
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


// -----------------------------------------------------------------------------
// #7636 · CA-5 / RS-3 — LÍNEA GREPEABLE del bloqueo en el log del Pulpo.
//
//   [entorno-hijo] bloqueado rol=<skill> fase=<fase> intento=<primary|fallback>:<provider> causa=<k1+k2> nombres=<n1,n2,…,(+N)>
//
// Doble saneo sobre lo que ya trae `details` (que pasó por `nombreSeguro`):
//   - `rol` y `fase` contra ^[a-z0-9-]{1,40}$ (si no, `(inválido)`).
//   - cada nombre contra ^[A-Za-z0-9_()]{1,64}$; el que no pasa se DESCARTA
//     (incluye los reemplazos con espacios de `nombreSeguro`, p. ej.
//     `(nombre no imprimible)`, y cualquier `\n`, `=`, `,` o espacio).
//   - hasta 8 nombres; el resto se resume como `(+N)`.
// Nunca lee valores: sólo `details.causas[].nombres` (invariante I-S2).
// -----------------------------------------------------------------------------
const LINEA_ROL_FASE = /^[a-z0-9-]{1,40}$/;
const LINEA_NOMBRE = /^[A-Za-z0-9_()]{1,64}$/;
const LINEA_INTENTO = /^[a-z0-9-]{1,40}(:[a-z0-9._-]{1,40})?$/;
const LINEA_MAX_NOMBRES = 8;

function rolFaseLinea(v) {
    return (typeof v === 'string' && LINEA_ROL_FASE.test(v)) ? v : '(inválido)';
}

function detailsDe(violation) {
    const d = violation && violation.details;
    return (d && typeof d === 'object') ? d : { causas: [] };
}

/** Clave estable de la causa: los `kind` presentes (enum cerrado), ordenados y unidos con `+`. */
function causaKey(violation) {
    const kinds = new Set();
    for (const c of detailsDe(violation).causas || []) {
        if (c && KINDS.includes(c.kind)) kinds.add(c.kind);
    }
    return kinds.size ? [...kinds].sort().join('+') : 'desconocida';
}

/** Nombres imprimibles de todas las causas (dedupe + orden), ya filtrados por LINEA_NOMBRE. */
function nombresBloqueados(violation) {
    const out = new Set();
    for (const c of detailsDe(violation).causas || []) {
        for (const n of (c && c.nombres) || []) {
            if (typeof n === 'string' && LINEA_NOMBRE.test(n)) out.add(n);
        }
    }
    return [...out].sort();
}

function formatChildEnvBlockedLine({ skill, fase, intento, violation } = {}) {
    const nombres = nombresBloqueados(violation);
    const visibles = nombres.slice(0, LINEA_MAX_NOMBRES);
    if (nombres.length > LINEA_MAX_NOMBRES) visibles.push(`(+${nombres.length - LINEA_MAX_NOMBRES})`);
    const intentoTxt = (typeof intento === 'string' && LINEA_INTENTO.test(intento)) ? intento : '(inválido)';
    return `[entorno-hijo] bloqueado rol=${rolFaseLinea(skill)} fase=${rolFaseLinea(fase)}`
        + ` intento=${intentoTxt} causa=${causaKey(violation)}`
        + ` nombres=${visibles.length ? visibles.join(',') : '(ninguno)'}`;
}

module.exports = {
    ChildEnvViolation,
    formatChildEnvBlockedLine,
    causaKey,
    nombresBloqueados,
    formatChildEnvViolation,
    isChildEnvViolation,
    CODE,
    KINDS,
    KIND_TEXTO_ES,
    DOC_PATH,
    DEFAULT_ANCHOR,
};
