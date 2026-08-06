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
//
// -----------------------------------------------------------------------------
// CORRECCIÓN DEL REVIEW DE #5337 (rebote del 2026-08-05)
// -----------------------------------------------------------------------------
// La primera versión evaluaba `re` y `qualifier` de forma INDEPENDIENTE sobre
// `title + body` concatenado. En bodies reales de 100+ líneas el qualifier
// siempre aparece en algún lado, así que el detector frenaba el 36% del intake
// real de definición (18 de 50 issues medidos) — exactamente el problema
// inverso al que #5337 arregla, y encima terminal: como el query de intake
// filtra `-label:needs-human`, un issue frenado por error queda fuera del
// intake PARA SIEMPRE hasta destrabe manual.
//
// Tres correcciones, todas medidas contra la población real de intake:
//
//   1. GATE DE MARCO DECISORIO (`DECISION_FRAME_PATTERNS`). El issue tiene que
//      PLANTEAR una decisión, no sólo mencionar temas. "Hay que definir dónde",
//      "elegir entre", "opción A", "trade-off". Sin marco decisorio no se
//      evalúa ni una señal. Éste es el filtro que hace el grueso del trabajo:
//      un bug report sobre refs de git no dice en ningún lado "hay que decidir".
//
//   2. CO-OCURRENCIA ACOTADA. `re` y `qualifier` tienen que caer en el MISMO
//      segmento (oración/línea) y a menos de `PROXIMITY_WINDOW` caracteres.
//      Mismo criterio que `HUMAN_BLOCK_PATTERNS` en `human-block.js` con su
//      `[\s\S]{0,80}?`.
//
//   3. SE IGNORA EL CÓDIGO (`stripCode`). Los bloques ``` y el código inline
//      son detalle de implementación, no prosa de decisión. `default_base_ref`
//      no está definido en `config.yaml`" hablaba de un default de config, no
//      de una decisión de arquitectura.
//
// Medición después del cambio (`gh issue list --label needs-definition
// --search "-label:needs-human" --limit 50`, o sea lo que consume brazoIntake):
//
//     antes:   50 issues | 18 frenados = 36%
//     después: 50 issues |  0 frenados =  0%
//
// Y los positivos siguen vivos: #5217 con su body real escala, igual que el
// fixture de CA-4c. Los 5 falsos positivos que el review documentó (#5322,
// #5292, #5283, #4817, #5205) son fixtures de regresión en el test.
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
// GATE DE MARCO DECISORIO (corrección 1 del review).
//
// Precondición de TODO el detector: el issue tiene que estar PLANTEANDO una
// decisión, no simplemente mencionando temas de arquitectura. Un bug report
// sobre refs de git menciona "local" y "remoto" veinte veces y no pide decidir
// nada; un issue que decide dónde vive un secreto dice "hay que definir dónde".
//
// Se mantienen deliberadamente estrechos (CA-4a). Dos patrones se probaron y se
// DESCARTARON por falsos positivos medidos contra el intake real:
//   - /no est[aá] definido/  → "`default_base_ref` no está definido en
//     `config.yaml`" (#5283). Habla de un default de config, no de una decisión.
//   - /(dos|tres|varias) caminos/ → "esos tres caminos degradan en silencio"
//     (#5394). "caminos" es narrativo, no enumeración de alternativas.
// Reemplazados por `queda sin definir` y por la variante sin "caminos".
// -----------------------------------------------------------------------------
const DECISION_FRAME_PATTERNS = Object.freeze([
    /\bhay\s+que\s+(?:definir|decidir|elegir|resolver|optar)\b/i,
    /\bqueda\s+(?:por|a)\s+(?:definir|decidir|elegir)\b/i,
    /\b(?:definir|decidir|elegir)\s+(?:si|d[oó]nde|cu[aá]l(?:es)?|qu[eé]|entre)\b/i,
    /\boptar\s+por\b/i,
    /\bopci[oó]n\s*[AB1-9]\b/i,
    /\balternativa\s*[AB1-9]\b/i,
    /\b(?:dos|tres|varias)\s+(?:alternativas|opciones)\b/i,
    /\btrade[-\s]?off\b/i,
    /\bqueda(?:n)?\s+sin\s+definir\b/i,
    /\bdecisi[oó]n\s+(?:de\s+)?(?:arquitectura|dise[nñ]o|estructural|pendiente)\b/i,
    /\bpor\s+decidir\b/i,
]);

// Ventana máxima entre `re` y `qualifier` dentro de un mismo segmento
// (corrección 2). Mismo orden de magnitud que el `[\s\S]{0,80}?` de
// `HUMAN_BLOCK_PATTERNS`, un poco más laxo porque acá el segmento ya es una
// oración: la ventana sólo ataja la línea de markdown patológicamente larga.
const PROXIMITY_WINDOW = 200;

/**
 * Saca bloques de código y código inline (corrección 3). Lo que va entre
 * backticks es nombre de símbolo, path o comando: detalle de implementación,
 * nunca la prosa donde se plantea una decisión de arquitectura.
 */
function stripCode(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
}

/**
 * Parte el texto en segmentos ~oración: primero por línea (el markdown usa el
 * salto de línea como separador semántico real — bullets, celdas, headings) y
 * después por terminador de oración.
 */
function splitSegments(text) {
    const out = [];
    for (const linea of String(text || '').split(/\r?\n/)) {
        for (const frase of linea.split(/(?<=[.;!?])\s+/)) {
            if (frase.trim()) out.push(frase);
        }
    }
    return out;
}

/**
 * ¿`re` y `qualifier` co-ocurren en este segmento a menos de
 * `PROXIMITY_WINDOW` caracteres? (corrección 2)
 *
 * Se comparan TODAS las posiciones de cada uno: alcanza con que exista UN par
 * cercano. Los regexes se clonan con `g` para no arrastrar `lastIndex` entre
 * llamadas (las fuentes son `Object.freeze`-adas y sin `g`, pero clonar es
 * gratis y evita un bug de estado compartido si alguien agrega una con `g`).
 */
function cooccursNear(segmento, re, qualifier) {
    const posRe = [...segmento.matchAll(new RegExp(re.source, 'gi'))].map((m) => m.index);
    if (posRe.length === 0) return false;
    const posQual = [...segmento.matchAll(new RegExp(qualifier.source, 'gi'))].map((m) => m.index);
    if (posQual.length === 0) return false;
    for (const i of posRe) {
        for (const j of posQual) {
            if (Math.abs(i - j) <= PROXIMITY_WINDOW) return true;
        }
    }
    return false;
}

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

    // Corrección 3 — el código no es prosa de decisión.
    const prosa = stripCode(txt);

    // Corrección 1 — GATE: sin marco decisorio no se evalúa ni una señal.
    // Es el filtro que saca el grueso de los falsos positivos: un bug report
    // menciona los temas pero nunca dice "hay que definir / elegir entre".
    if (!DECISION_FRAME_PATTERNS.some((re) => re.test(prosa))) {
        return { ...base, note: 'no plantea ninguna decisión (sin marco decisorio) — se deja pasar (CA-4b)' };
    }

    // Corrección 2 — CO-OCURRENCIA ACOTADA: `re` y `qualifier` en el MISMO
    // segmento y cerca. Evaluarlos sueltos sobre todo el body hacía que el
    // qualifier apareciera "en algún lado" de cualquier issue largo.
    const segmentos = splitSegments(prosa);
    const matched = [];
    for (const sig of DESIGN_DECISION_SIGNALS) {
        // CA-4a — las DOS condiciones. El tema solo nunca alcanza.
        if (segmentos.some((seg) => cooccursNear(seg, sig.re, sig.qualifier))) matched.push(sig);
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
    DECISION_FRAME_PATTERNS,
    DECISION_SETTLED_LABELS,
    DECISION_SETTLED_PATTERNS,
    PROXIMITY_WINDOW,
    stripCode,
    splitSegments,
    cooccursNear,
    isDecisionSettled,
    detectDesignDecision,
};
