// .pipeline/lib/rejection-severity.js
// =============================================================================
// Severidad de un rechazo de validador (#6296).
//
// POR QUÉ EXISTE
// --------------
// Hasta #6296 el pipeline trataba un veredicto `rejected` como AMBIGÜEDAD y lo
// escalaba a `needs-human`. Un rechazo no es ambigüedad: es una decisión válida
// que ya dice qué hacer. El criterio aprobado por el operador (2026-08-21,
// "C con piso A") desempata por SEVERIDAD:
//
//   - `grave` ⇒ el issue vuelve a `dev` (rebote de código).
//   - `leve`  ⇒ no frena: observación al PR y la fase se re-corre completa.
//
// PISO A (fail-closed): la severidad la fija el validador que rechazó. Si NO la
// declara —o declara cualquier cosa fuera de la whitelist— se trata como
// `grave`. Nunca auto-aprueba por silencio.
//
// FUENTE ÚNICA
// ------------
// Este módulo es el ÚNICO lugar donde se decide la severidad. Lo consumen tres
// capas (`stuck-phase-detector`, `stuck-phase-reconciler` vía el detector, y
// `block-classifier`). Reimplementar la regla en cualquiera de ellas reproduce
// exactamente la divergencia detector↔reconciler que #5641 vino a cerrar.
//
// PURO: sin `require` de `fs`/`path`/config. La pureza está testeada
// (`rejection-severity.test.js`), no es una convención opcional: si este módulo
// leyera config, el detector dejaría de ser puro y CA-8 caería.
// =============================================================================

'use strict';

/** Whitelist CERRADA. Cualquier valor fuera de acá ⇒ `grave` (fail-closed). */
const SEVERIDADES = Object.freeze(['grave', 'leve']);

/**
 * Skills cuyo rechazo es SIEMPRE grave, ignorando lo que declaren.
 *
 * Espejo conceptual del invariante RIESGO-2 de `observation-classifier.js`
 * (un rechazo de `security` con claim empírico es siempre accionable) y del
 * default en código de `convergence-detector.js`. Va en CÓDIGO y no en
 * `config.yaml` a propósito: un piso de seguridad editable por config es un
 * piso que se puede bajar sin review.
 */
const SKILLS_PISO_GRAVE = Object.freeze(['security']);

/**
 * Skills cuyo MOTIVO de rechazo NUNCA se publica en una superficie pública
 * (comentario de issue o de PR). `intrale/platform` es un repo PUBLIC.
 *
 * POR QUÉ ES UNA LISTA APARTE DE `SKILLS_PISO_GRAVE`
 * -------------------------------------------------
 * Son dos decisiones distintas que hoy caen en el mismo skill:
 *   - `SKILLS_PISO_GRAVE`  responde "¿frena el issue?"  ⇒ severidad.
 *   - `SKILLS_SIN_MOTIVO_PUBLICO` responde "¿el texto puede salir?" ⇒ difusión.
 * Colapsarlas ata la difusión a la severidad, y mañana un skill grave-pero-
 * publicable (o publicable-pero-leve) obligaría a desarmar el piso de seguridad.
 *
 * FUENTE ÚNICA (#6296 rev-3): la consumen los DOS carriles de publicación
 * -- el leve (`buildObservacion` → `pr-comment`) y el grave (dep `rebote` →
 * `comment`). Tenía una copia local en `stuck-phase-reconciler.js` que sólo
 * cubría el carril leve, al que `security` NUNCA llega por el piso de arriba:
 * el control vivía donde era inalcanzable y faltaba donde siempre corre. Toda
 * lectura de esta lista pasa por acá para que no vuelva a divergir.
 *
 * La redacción de secretos NO sustituye esta lista: `redact` apunta a VALORES
 * (AKIA…, JWT, `token=`), y un motivo como "SQL injection en Foo.kt:42 vía
 * parámetro sin sanitizar" no matchea ningún patrón y saldría verbatim.
 */
const SKILLS_SIN_MOTIVO_PUBLICO = Object.freeze(['security']);

/**
 * ¿Alguno de estos skills obliga a ocultar el motivo en superficie pública?
 *
 * Fail-closed por diseño: basta UN skill sensible para ocultar el bloque de
 * motivo completo. No se publica "la parte no-sensible" de un texto mixto --
 * los motivos se concatenan y separar por autor es frágil.
 *
 * @param {Array<string|{skill?:string}>} skills skills que rechazaron (o sus
 *   registros de rechazo; se acepta cualquiera de las dos formas porque cada
 *   carril tiene la suya a mano).
 * @returns {boolean} `true` si el motivo debe omitirse. Entrada no-array ⇒
 *   `true`: sin lista legible de autores no se puede afirmar que sea publicable.
 */
function ocultaMotivoPublico(skills) {
    if (!Array.isArray(skills)) return true;
    return skills.some((s) => {
        const nombre = (s && typeof s === 'object') ? s.skill : s;
        return SKILLS_SIN_MOTIVO_PUBLICO.includes(String(nombre == null ? '' : nombre).trim().toLowerCase());
    });
}

/** `'grave'` es el default fail-closed de todo el módulo. */
const GRAVE = 'grave';
const LEVE = 'leve';

/**
 * Resuelve la severidad efectiva de UN rechazo.
 *
 * PROCEDENCIA ÚNICA: recibe SÓLO el YAML del veredicto del skill que rechazó.
 * No acepta body de issue/PR, guidance ni handoff — todos ellos son texto de
 * terceros y aceptarlos convertiría el gate en spoofeable.
 *
 * @param {object}  args
 * @param {string}  [args.skill]  skill que emitió el rechazo
 * @param {object}  [args.yaml]   YAML del veredicto (sólo se lee `severidad`)
 * @returns {'grave'|'leve'}
 */
function resolveSeverity(args = {}) {
    const skill = String((args && args.skill) || '').trim().toLowerCase();

    // Piso por skill ANTES de mirar lo declarado: `security` no puede
    // auto-degradarse escribiendo `severidad: leve`.
    if (SKILLS_PISO_GRAVE.includes(skill)) return GRAVE;

    const yaml = args && args.yaml;
    // Sin objeto de veredicto (null, array, string, número) no hay procedencia
    // verificable ⇒ grave. `typeof null === 'object'`, por eso la guarda explícita.
    if (!yaml || typeof yaml !== 'object' || Array.isArray(yaml)) return GRAVE;

    const raw = yaml.severidad;
    // Sólo strings. Un `severidad: []` / `{}` / `0` / `true` NO es una
    // declaración legible ⇒ grave. Prohibido el `!== 'leve'` implícito: con él,
    // un objeto raro colapsaría a grave "por accidente" en vez de por regla.
    if (typeof raw !== 'string') return GRAVE;

    const norm = raw.trim().toLowerCase();
    if (!SEVERIDADES.includes(norm)) return GRAVE;
    return norm === LEVE ? LEVE : GRAVE;
}

/**
 * Severidad efectiva de un CONJUNTO de rechazos: un solo `grave` gana sobre N
 * `leve`. Nunca se promedia — fail-closed.
 *
 * @param {Array<{skill?:string, yaml?:object}>} rechazos
 * @returns {'grave'|'leve'} `grave` si la lista está vacía (no hay nada que
 *   habilite el carril liviano sin una decisión explícita).
 */
function resolveSeverityAgregada(rechazos) {
    const list = Array.isArray(rechazos) ? rechazos : [];
    if (list.length === 0) return GRAVE;
    return list.some((r) => resolveSeverity(r || {}) === GRAVE) ? GRAVE : LEVE;
}

module.exports = {
    resolveSeverity,
    resolveSeverityAgregada,
    SEVERIDADES,
    SKILLS_PISO_GRAVE,
    SKILLS_SIN_MOTIVO_PUBLICO,
    ocultaMotivoPublico,
    GRAVE,
    LEVE,
};
