// =============================================================================
// design-decision-detect.js — "esto es una decisión de arquitectura, no una
// tarea de implementación" (#5337, CA-4a / CA-4b / CA-4c).
//
// EL CASO QUE ORIGINA ESTE MÓDULO (#5217, 2026-08-01)
// ---------------------------------------------------
// Un issue de "store de credenciales del pipeline" resolvió por su cuenta que
// el vault iba a ser un archivo JSON en disco local. Nunca planteó eso como una
// decisión: el épico #5215 asumió la solución en vez de escalarla. Un diseño
// que no cumple el requisito de ejecución distribuida multi-host llegó hasta PR
// sin que el operador supiera que había algo que decidir.
//
// EL RIESGO INVERSO, Y POR QUÉ ESTE MÓDULO ES DELIBERADAMENTE ESTRECHO
// --------------------------------------------------------------------
// Los otros triggers de #5337 leen un estado objetivo de la API de GitHub
// (`mergeStateStatus`, alertas de code-scanning). Éste tiene que clasificar
// texto libre, que es mucho más resbaloso. Y el costo del falso positivo es el
// INVERSO EXACTO del problema que #5337 arregla: un issue sano frenado
// esperando a un humano que no tiene nada que decidir.
//
// De ahí las tres reglas que fijó el PO:
//   CA-4a — dispara SÓLO ante señales explícitas y enumeradas EN EL CÓDIGO.
//           La lista vive acá y en ningún otro lado (`DESIGN_DECISION_SIGNALS`).
//   CA-4b — ante duda o señal no reconocida: DEJAR PASAR Y REGISTRAR, nunca
//           frenar. El default de este módulo es `escalate: false`.
//   CA-4c — #5217 es fixture de test: ese caso SÍ tiene que escalar.
//
// Nótese la asimetría con el resto del pipeline: acá el default es fail-OPEN a
// propósito. En los gates de firma el silencio bloquea; en un CLASIFICADOR de
// texto libre, bloquear por defecto significaría frenar el pipeline entero.
// Lo que nunca se auto-resuelve es el bloqueo YA creado (eso es CA-5).
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// CA-4a — Señales explícitas. FUENTE ÚNICA. No hay heurística dispersa en otros
// archivos: quien quiera agregar una señal la agrega acá y le escribe su test.
//
// Cada señal necesita DOS coincidencias para contar (`re` + `qualifier`): el
// tema solo no alcanza. "Guardamos el token en el store" habla de credenciales
// pero no plantea ninguna alternativa; "dónde guardamos las credenciales:
// ¿archivo local o servicio externo?" sí.
// -----------------------------------------------------------------------------
const DESIGN_DECISION_SIGNALS = Object.freeze([
    {
        key: 'alternativas-enumeradas',
        descripcion: 'El issue plantea opciones excluyentes sin elegir una',
        re: /\b(?:alternativas?|opci[oó]n(?:es)?)\b/i,
        qualifier: /\b(?:opci[oó]n\s*[AB1-9]|alternativa\s*[AB1-9]|vs\.?|versus|o\s+bien|elegir\s+entre|trade[-\s]?off)\b/i,
        pregunta: '¿Cuál de las alternativas planteadas tomamos?',
    },
    {
        key: 'servicio-externo',
        descripcion: 'Propone adoptar un servicio/proveedor externo nuevo',
        re: /\b(?:servicio|proveedor|provider|SaaS|vault|bucket|base\s+de\s+datos|broker)\s+externo\b|\badoptar\s+(?:un\s+)?(?:servicio|proveedor|provider)\b/i,
        qualifier: /\b(?:adoptar|contratar|integrar|migrar\s+a|depender\s+de|costo|pricing|tier)\b/i,
        pregunta: '¿Adoptamos un servicio externo para esto? Implica costo y dependencia nueva.',
    },
    {
        key: 'dato-critico',
        descripcion: 'Define dónde vive un dato crítico (credenciales, estado, secretos)',
        re: /\b(?:credenciales?|secretos?|tokens?|claves?|api\s*keys?|estado\s+operativo)\b/i,
        qualifier: /\b(?:d[oó]nde\s+(?:viven?|se\s+(?:guardan?|almacenan?|persisten?))|almacenamiento|store|vault|persistencia)\b/i,
        pregunta: '¿Dónde vive este dato crítico? La elección condiciona todo lo que venga después.',
    },
    {
        key: 'local-vs-distribuido',
        descripcion: 'Define si algo es local a un host o distribuido multi-host',
        re: /\b(?:local|en\s+disco|filesystem|single[-\s]host|un\s+solo\s+host)\b/i,
        qualifier: /\b(?:distribuid[oa]|multi[-\s]host|compartid[oa]\s+entre|remot[oa]|centraliz)/i,
        pregunta: '¿Esto es local a un host o tiene que funcionar distribuido? No es reversible barato.',
    },
]);

// -----------------------------------------------------------------------------
// Señales de que la decisión YA fue tomada por un humano. Sin esto el detector
// re-escalaría el mismo issue en cada barrido después de que el operador
// respondió — spam infinito y, peor, un issue destrabado que se vuelve a trabar.
// -----------------------------------------------------------------------------
const DECISION_SETTLED_LABELS = Object.freeze([
    'decision:approved',
    'recommendation:approved',
]);
const DECISION_SETTLED_PATTERNS = Object.freeze([
    /\bdecisi[oó]n\s+(?:tomada|aprobada|cerrada)\b/i,
    /\bdecidido\s+por\s+(?:el\s+)?operador\b/i,
    /\bsign[-\s]?off\s+del?\s+operador\b/i,
]);

/**
 * ¿La decisión ya está cerrada (por label o por texto explícito)?
 */
function isDecisionSettled({ body = '', labels = [] } = {}) {
    const names = (Array.isArray(labels) ? labels : [])
        .map((l) => (typeof l === 'string' ? l : (l && l.name)))
        .filter(Boolean);
    for (const l of names) {
        if (DECISION_SETTLED_LABELS.includes(l)) return true;
    }
    const txt = String(body || '');
    for (const re of DECISION_SETTLED_PATTERNS) {
        if (re.test(txt)) return true;
    }
    return false;
}

/**
 * CA-4a/4b — Decide si un issue de definición implica una decisión de
 * arquitectura estructural que el pipeline NO debe tomar por default.
 *
 * Contrato de salida (siempre un objeto, nunca lanza — este detector corre
 * dentro del intake y una excepción suya no puede frenar el pipeline):
 *
 *   {
 *     escalate: boolean,       // false = dejar pasar (default, CA-4b)
 *     signals: string[],       // keys de DESIGN_DECISION_SIGNALS que matchearon
 *     reason, question,        // sólo con contenido si escalate === true
 *     recommendation,
 *     note                     // CA-4b: por qué se dejó pasar, para el log
 *   }
 *
 * @param {object} args
 * @param {string} [args.title]
 * @param {string} [args.body]
 * @param {Array}  [args.labels]
 * @param {number} [args.issue]
 */
function detectDesignDecision({ issue, title = '', body = '', labels = [] } = {}) {
    const base = { escalate: false, signals: [], reason: '', question: '', recommendation: '', note: '' };
    let txt;
    try {
        txt = `${String(title || '')}\n${String(body || '')}`;
    } catch {
        return { ...base, note: 'input ilegible — se deja pasar (CA-4b)' };
    }
    if (!txt.trim()) {
        return { ...base, note: 'sin texto para clasificar — se deja pasar (CA-4b)' };
    }

    // La decisión ya la tomó un humano: no re-escalar (idempotencia).
    if (isDecisionSettled({ body: txt, labels })) {
        return { ...base, note: 'decisión ya cerrada por el operador — se deja pasar' };
    }

    const matched = [];
    for (const sig of DESIGN_DECISION_SIGNALS) {
        // CA-4a — las DOS condiciones. El tema solo nunca alcanza.
        if (sig.re.test(txt) && sig.qualifier.test(txt)) matched.push(sig);
    }

    // CA-4b — ninguna señal reconocida → dejar pasar y registrar. Este es el
    // camino del 99% de los issues y tiene que ser barato y silencioso.
    if (matched.length === 0) {
        return { ...base, note: 'ninguna señal estructural reconocida — se deja pasar (CA-4b)' };
    }

    const keys = matched.map((s) => s.key);
    const preguntas = matched.map((s) => s.pregunta);
    return {
        escalate: true,
        signals: keys,
        reason: `La definición de${issue ? ` #${issue}` : ''} implica una decisión de arquitectura estructural que el pipeline no debe tomar por default. Señales detectadas: ${matched.map((s) => `${s.key} (${s.descripcion})`).join('; ')}.`,
        question: `Antes de que definición elija por su cuenta: ${preguntas.join(' ')}`,
        recommendation: 'Dejá la decisión escrita en el issue con las alternativas y la elegida. Si queda implícita en el body, la próxima fase la vuelve a asumir sin escalarla (fue lo que pasó con #5217).',
        note: '',
    };
}

module.exports = {
    DESIGN_DECISION_SIGNALS,
    DECISION_SETTLED_LABELS,
    DECISION_SETTLED_PATTERNS,
    isDecisionSettled,
    detectDesignDecision,
};
