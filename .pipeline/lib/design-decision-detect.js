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
// #6448 UX-2 — Traducción `señal → frase que lee el operador`. FUENTE ÚNICA,
// al lado de `DESIGN_DECISION_SIGNALS` a propósito: son dos vistas del mismo
// hecho y separarlas de archivo es cómo divergen.
//
// Por qué existe: `alternativas-enumeradas` es un IDENTIFICADOR DE CÓDIGO. Que
// el aviso del operador dijera "Señales detectadas: alternativas-enumeradas
// (El issue plantea opciones excluyentes sin elegir una)" es jerga de
// implementación (CA-20 / UX-2). Las keys van al log y a la traza auditable
// (CA-27); al operador va la frase.
// -----------------------------------------------------------------------------
const SIGNAL_COPY = Object.freeze({
    'alternativas-enumeradas': Object.freeze({
        frase: 'plantea opciones excluyentes y no elige una',
        pregunta: '¿cuál de las opciones tomamos?',
    }),
    'servicio-externo': Object.freeze({
        frase: 'propone sumar un servicio de un tercero',
        pregunta: '¿sumamos ese servicio de tercero, con el costo y la dependencia que trae?',
    }),
    'dato-critico': Object.freeze({
        frase: 'define dónde va a vivir un dato crítico',
        pregunta: '¿dónde vive ese dato?',
    }),
    'local-vs-distribuido': Object.freeze({
        frase: 'define si esto corre en una sola máquina o en varias',
        pregunta: '¿una sola máquina o varias?',
    }),
});

// UX-3 — cuántas señales se enumeran en el motivo antes de resumir el resto.
// Medido por `ux` contra el tope de render: con 4 señales enumeradas el motivo
// se come el cierre accionable.
const MAX_SENALES_EN_COPY = 3;

// UX-4 / CA-UX-2 — tope de la pregunta que lee el operador. `decision-card.js`
// exige ≤160 para citarla literal; más largo y la ficha degrada a
// "no supe clasificar", que es peor que una pregunta con menos detalle.
const MAX_PREGUNTA_OPERADOR = 160;

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
function cooccurrenceIndex(segmento, re, qualifier) {
    const s = String(segmento == null ? '' : segmento);
    if (!s) return null;
    const posRe = [...s.matchAll(new RegExp(re.source, 'gi'))].map((m) => m.index);
    if (posRe.length === 0) return null;
    const posQual = [...s.matchAll(new RegExp(qualifier.source, 'gi'))].map((m) => m.index);
    if (posQual.length === 0) return null;
    for (const i of posRe) {
        for (const j of posQual) {
            if (Math.abs(i - j) <= PROXIMITY_WINDOW) return { index: i, qualifierIndex: j };
        }
    }
    return null;
}

function cooccursNear(segmento, re, qualifier) {
    return cooccurrenceIndex(segmento, re, qualifier) !== null;
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
 * ¿La decisión ya está cerrada (por label, por texto explícito, o —#6448— por
 * la firma del arquitecto ya verificada por el caller)?
 *
 * @param {object}  args
 * @param {string}  [args.body]
 * @param {Array}   [args.labels]
 * @param {object}  [args.signoff] — veredicto YA RESUELTO de
 *   `evaluateArchitectSignoff()`. Nunca una promesa ni un fetcher: este módulo
 *   es síncrono y sin I/O por contrato (A-1/A-2, CA-15).
 */
function isDecisionSettled({ body = '', labels = [], signoff = null } = {}) {
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
    // #6448 — la firma del arquitecto también cierra la decisión. Va AL FINAL
    // para que la invocación histórica de dos campos siga dando exactamente el
    // mismo resultado que antes (CA-15).
    if (signoff && signoff.settled === true) return true;
    return false;
}

// =============================================================================
// #6448 — FRAGMENTO DISPARADOR (punto 3 del issue, CA-17..CA-21)
//
// El motivo decía QUÉ señal matcheó pero no DÓNDE. El operador tenía que abrir
// el issue y releerlo entero para evaluar el freno. Ahora el veredicto expone
// el pedazo de texto que lo disparó, en un CAMPO PROPIO (`fragment`) — nunca
// concatenado dentro del motivo (UX-1).
//
// Por qué campo propio y no concatenación: `ux` corrió el render real y midió
// que el motivo se recorta antes de que el fragmento entre, dejando además una
// comilla abierta. Un test sobre `veredicto.reason` pasaba en verde con el
// operador viendo un mensaje roto.
//
// ORDEN DE OPERACIONES NO NEGOCIABLE (RS-2.1/RS-2.2, CA-18/CA-21):
//   1. ubicar el match   2. recortar la ventana   3. REDACTAR   4. tope + elipsis
// Redactar DESPUÉS de recortar puede partir un secreto por la mitad y dejar
// pasar la otra mitad. Primero se redacta, después se recorta.
// =============================================================================

const { redactAll } = require('./sherlock-audit-jsonl');

// Tope duro EN EL ORIGEN (RS-2.2 / CA-18). La vista recorta de nuevo por su
// cuenta, pero no se le delega: un body de 60 KB no puede viajar entero al
// `.reason.json` ni a la traza auditable.
const FRAGMENT_MAX = 200;

/**
 * Deja el texto con las comillas dobles balanceadas (UX-4 / CA-UX-5).
 *
 * El fragmento se emite envuelto en `"…"`. Si el recorte dejó una comilla
 * abierta adentro, el operador ve una cita que nunca cierra — el modo de falla
 * exacto que `ux` midió en vivo.
 */
function balancearComillas(texto) {
    let s = String(texto == null ? '' : texto);
    while ((s.match(/"/g) || []).length % 2 !== 0) {
        const ult = s.lastIndexOf('"');
        if (ult < 0) break;
        s = (s.slice(0, ult) + s.slice(ult + 1)).replace(/\s+$/, '');
    }
    return s;
}

/**
 * Recorta en BORDE DE PALABRA y cierra con una sola elipsis `…` (UX-4).
 * Nunca tres puntos: son tres caracteres para decir lo que dice uno.
 */
function recortarConElipsis(texto, max) {
    const s = String(texto == null ? '' : texto).trim();
    if (!s) return '';
    if (s.length <= max) return balancearComillas(s);
    const duro = s.slice(0, max - 1);
    const corte = duro.lastIndexOf(' ');
    const base = corte > max * 0.6 ? duro.slice(0, corte) : duro;
    return balancearComillas(base.replace(/[\s,;:.]+$/, '')) + '…';
}

/**
 * Fragmento del body que disparó `signal`, listo para citar.
 *
 * PURO y NUNCA LANZA: ante cualquier fallo devuelve cadena vacía y el aviso
 * queda como estaba antes de #6448 (sin evidencia, pero entregado).
 *
 * @param {string[]} segmentos — salida de `splitSegments()`.
 * @param {object}   signal    — entrada de `DESIGN_DECISION_SIGNALS`.
 * @param {object}   [opts]
 * @param {number}   [opts.max=FRAGMENT_MAX]
 * @returns {string}
 */
function signalFragment(segmentos, signal, { max = FRAGMENT_MAX } = {}) {
    try {
        if (!signal || !signal.re || !signal.qualifier) return '';
        if (!Array.isArray(segmentos)) return '';
        for (const seg of segmentos) {
            // 1 — ubicar el match reusando la MISMA lógica de posiciones que
            // decidió la co-ocurrencia. Duplicarla haría que el fragmento
            // citara un lugar distinto del que disparó la señal.
            const pos = cooccurrenceIndex(seg, signal.re, signal.qualifier);
            if (!pos) continue;
            const texto = String(seg);
            // 2 — ventana centrada entre el tema y su calificador.
            const centro = Math.round((pos.index + pos.qualifierIndex) / 2);
            const ini = Math.max(0, centro - PROXIMITY_WINDOW);
            const fin = Math.min(texto.length, centro + PROXIMITY_WINDOW);
            // 3 — REDACTAR (antes de cualquier recorte adicional).
            const redactado = String(redactAll(texto.slice(ini, fin)))
                .replace(/\s+/g, ' ')   // el markdown trae saltos: rompen la línea del aviso
                .trim();
            // 4 — tope duro + elipsis + comillas balanceadas.
            return recortarConElipsis(redactado, max);
        }
        return '';
    } catch {
        return '';
    }
}

// =============================================================================
// #6448 — ¿HAY FIRMA DEL ARQUITECTO? (punto 1 del issue)
//
// EL DEFECTO QUE ESTO CIERRA (incidente del 2026-08-24). #6431 tenía publicada
// la firma del arquitecto —con la receta técnica cerrada— y el gate lo frenó
// igual, porque `isDecisionSettled()` sólo miraba el body y los labels. La
// firma vive en un COMENTARIO, que es justo donde el pipeline la deposita: la
// señal que cerraba la decisión existía, estaba publicada, y el detector
// estructuralmente no podía verla.
//
// DIRECCIÓN DEL FAIL (D-3 / RS-3.1). Este carril es FAIL-CLOSED, al revés que
// el resto del módulo: la ambigüedad en la DETECCIÓN deja pasar, pero la
// ambigüedad en la VERIFICACIÓN DE LA FIRMA escala. "No pude comprobar que un
// humano firmó" nunca puede significar "asumo que firmó".
// =============================================================================

const architectGate = require('./architect-signoff-gate');
const { SECTION_HEADER_RE } = require('./handoff');

/** Skill que puede firmar. Constante para que el test no reescriba el literal. */
const ARCHITECT_SKILL_ID = 'architect';

/**
 * Marca de autoría de agente en un comentario, CAPTURANDO el skill declarado
 * (A-8). No alcanza con matchear: el arquitecto ES un agente del pipeline y su
 * firma lleva ese pie, así que "cualquier pie descalifica" rechaza la firma
 * legítima — medido sobre las 5 firmas estrictas reales del repo, 1 lo lleva.
 *
 * Capturar el skill conserva intacto el valor defensivo de RS-1.4: la cadena de
 * explotación es "un `guru`/`po`/`doc` inyectado emite el marcador", y esos
 * comentarios se autodeclaran con SU skill, así que siguen descartados.
 *
 * Dos formas, verificadas contra comentarios reales:
 *   🤖 `architect` · fase `criterios` · pipeline `definicion`  → architect
 *   > Producido por el agente `ux` en la fase `criterios`.     → ux
 *
 * `u` por el emoji; `g` porque puede haber más de una marca en el mismo body.
 */
const AGENT_FOOTER_RE = /(?:\u{1F916}\s*`?([a-z][a-z0-9_-]*)`?\s*[·.]\s*fase|producido por el agente\s+`?([a-z][a-z0-9_-]*)`?)/giu;

/** Motivos de descarte, enumerados para que la traza (CA-28) sea agregable. */
const SIGNOFF_REJECT = Object.freeze({
    SIN_MARCADOR: 'sin-marcador-estricto-en-linea-completa',
    OTRO_ISSUE: 'marcador-de-otro-issue',
    AUTORIA: 'author-association-no-autorizada',
    FOOTER: 'footer-de-agente-ajeno',
    HANDOFF: 'seccion-de-handoff-no-es-firma',
    MINIMIZADO: 'comentario-minimizado',
    OBSOLETA: 'firma-anterior-a-la-ultima-edicion-del-body',
    SIN_CORROBORACION: 'sin-corroboracion-en-traza-local',
});

/** Divide en líneas tolerando CRLF (CA-35). Hay comentarios CRLF reales. */
function lineasDe(texto) {
    return String(texto == null ? '' : texto).split(/\r?\n/);
}

/**
 * Conjunto de skills que el comentario declara como autores (A-8).
 * Vacío = no hay marca de agente.
 */
function skillsDeclarados(body) {
    const out = new Set();
    const re = new RegExp(AGENT_FOOTER_RE.source, AGENT_FOOTER_RE.flags);
    for (const m of String(body == null ? '' : body).matchAll(re)) {
        const skill = (m[1] || m[2] || '').toLowerCase();
        if (skill) out.add(skill);
    }
    return out;
}

/**
 * ¿Este comentario es una firma de arquitecto válida para `issue`?
 *
 * Las SIETE condiciones de D-1 + A-8, en orden. Cada rechazo devuelve su motivo
 * para la traza (CA-28 / RS-5.2): sin el negativo sólo se cuentan falsos
 * positivos y no se detecta un intento de bypass.
 *
 * @returns {{ok: true} | {ok: false, motivo: string}}
 */
function evalComentarioFirma(comment, issue, lastEditedMs, audit) {
    const body = comment && comment.body != null ? String(comment.body) : '';

    // (a) alguna LÍNEA COMPLETA matchea el marcador estricto (RS-1.1 / A-5).
    //     Nunca substring: el propio aviso de destrabe CITA el marcador, y con
    //     un regex laxo ese aviso desarmaría el gate.
    let capturado = null;
    for (const linea of lineasDe(body)) {
        const m = architectGate.STRICT_MARKER_LINE_REGEX.exec(linea);
        if (m) { capturado = m[1]; break; }
    }
    if (capturado === null) return { ok: false, motivo: SIGNOFF_REJECT.SIN_MARCADOR };

    // (b) el número capturado es el issue evaluado (RS-1.2). Sin esto, una
    //     firma de #6431 citada dentro de #6432 desarma #6432.
    if (Number(capturado) !== Number(issue)) return { ok: false, motivo: SIGNOFF_REJECT.OTRO_ISSUE };

    // (c) `authorAssociation` en la allowlist (RS-1.3). Piso, no techo.
    if (!architectGate.ALLOWED_AUTHOR_ASSOCIATIONS.includes(comment && comment.authorAssociation)) {
        return { ok: false, motivo: SIGNOFF_REJECT.AUTORIA };
    }

    // (d) ninguna marca de autoría declara un skill AJENO, y ninguna línea
    //     completa es un header de handoff (CA-9 / CA-9b / CA-9c).
    for (const skill of skillsDeclarados(body)) {
        if (skill !== ARCHITECT_SKILL_ID) {
            return { ok: false, motivo: `${SIGNOFF_REJECT.FOOTER}:${skill}` };
        }
    }
    for (const linea of lineasDe(body)) {
        if (SECTION_HEADER_RE.test(linea)) return { ok: false, motivo: SIGNOFF_REJECT.HANDOFF };
    }

    // (e) no está oculto por spam/abuse (RS-1.5).
    if (comment && comment.isMinimized === true) return { ok: false, motivo: SIGNOFF_REJECT.MINIMIZADO };

    // (f) la firma es POSTERIOR a la última edición del body (RS-3.3/RS-3.4).
    //     Se usa `createdAt`, no el `lastEditedAt` del comentario: ese le daría
    //     a un comentario viejo re-editado una frescura que no tiene.
    const firmaMs = Date.parse(comment && comment.createdAt);
    if (!Number.isFinite(firmaMs)) return { ok: false, motivo: 'firma sin fecha parseable' };
    // `lastEditedMs === null` = body nunca editado ⇒ no hay edición posterior
    // que pueda haber invalidado la firma ⇒ (f) cumplida (CA-5 / RS-3.2).
    if (lastEditedMs !== null && !(firmaMs > lastEditedMs)) {
        return { ok: false, motivo: SIGNOFF_REJECT.OBSOLETA };
    }

    // (g) corroboración en la traza local del arquitecto (A-8). Es el único
    //     discriminador que NO escribe el LLM: lo escribe código durante la
    //     corrida del arquitecto. Una inyección que viaja por el body del issue
    //     hasta la salida de texto de otro agente no puede producirlo.
    //
    //     Excepción única (CA-34): traza no disponible ⇒ (g) cumplida.
    //     `.pipeline/audit/` es local y gitignored: un respawn la borra, y
    //     hacerlo fail-closed haría que el gate frene MÁS que hoy — el
    //     anti-patrón que este issue existe para cerrar.
    if (audit && audit.available === true && audit.corroborated !== true) {
        return { ok: false, motivo: SIGNOFF_REJECT.SIN_CORROBORACION };
    }

    return { ok: true };
}

/**
 * Veredicto de firma de arquitecto sobre los comentarios de un issue.
 *
 * PURA y NUNCA LANZA (CA-14). Todo el I/O (la consulta a GitHub y la lectura de
 * la traza local) vive en `design-decision-gate-io.js`: acá entra ya resuelto.
 *
 * @param {object}   args
 * @param {number}   args.issue
 * @param {Array}    args.comments      — `{ createdAt, body, authorAssociation, isMinimized }`
 * @param {string?}  args.lastEditedAt  — ISO o `null` (body nunca editado)
 * @param {object}   [args.audit]       — `{ available, corroborated }` de `readSignoffAudit()`
 * @returns {{settled: boolean, reason: string, rejected: Array<{createdAt: string, motivo: string}>}}
 */
function evaluateArchitectSignoff({ issue, comments, lastEditedAt, audit = null } = {}) {
    const rechazados = [];
    try {
        const n = Number(issue);
        if (!Number.isInteger(n) || n <= 0) {
            return { settled: false, reason: 'firma no verificable: issue no es un entero positivo', rejected: rechazados };
        }
        if (!Array.isArray(comments)) {
            return { settled: false, reason: 'firma no verificable: la respuesta no trajo comentarios', rejected: rechazados };
        }
        let lastEditedMs = null;
        if (lastEditedAt != null && String(lastEditedAt) !== '') {
            lastEditedMs = Date.parse(lastEditedAt);
            if (!Number.isFinite(lastEditedMs)) {
                return { settled: false, reason: 'firma no verificable: fecha de edición del body ilegible', rejected: rechazados };
            }
        }

        let hubo = false;
        for (const c of comments) {
            const r = evalComentarioFirma(c, n, lastEditedMs, audit);
            if (r.ok) {
                hubo = true;
                break;
            }
            // Sólo se registra el descarte de comentarios que AL MENOS traían el
            // marcador: lo demás es el 99% de los comentarios de cualquier issue
            // y llenaría la traza de ruido.
            if (r.motivo !== SIGNOFF_REJECT.SIN_MARCADOR) {
                rechazados.push({
                    createdAt: String((c && c.createdAt) || ''),
                    motivo: r.motivo,
                });
            }
        }

        if (hubo) {
            const corroboracion = audit && audit.available === true
                ? 'corroborada en la traza local'
                : 'traza local no disponible';
            return { settled: true, reason: `firma de arquitecto vigente (${corroboracion})`, rejected: rechazados };
        }
        return {
            settled: false,
            reason: rechazados.length
                ? `sin firma vigente (${rechazados.length} descartada/s)`
                : 'sin firma de arquitecto publicada',
            rejected: rechazados,
        };
    } catch (e) {
        // CA-14 — nunca lanza. Fail-closed del carril de firma.
        return {
            settled: false,
            reason: `firma no verificable: ${String((e && e.message) || e).slice(0, 120)}`,
            rejected: rechazados,
        };
    }
}

/**
 * UX-3 — motivo que lee el operador. La frase ACCIONABLE va PRIMERO y la
 * enumeración después: si el recorte del render muerde algo, tiene que morder
 * la lista de señales, nunca el "qué hago con esto".
 *
 * Máximo `MAX_SENALES_EN_COPY` señales enumeradas; el resto se resume.
 */
function buildOperatorReason(issue, keys) {
    const ref = issue ? ` #${issue}` : '';
    const frases = keys
        .map((k) => (SIGNAL_COPY[k] || {}).frase)
        .filter(Boolean);
    const visibles = frases.slice(0, MAX_SENALES_EN_COPY);
    const sobran = frases.length - visibles.length;
    let lista = visibles.join('; ');
    if (sobran > 0) lista += `; y ${sobran} cosa${sobran === 1 ? '' : 's'} más`;
    const cabeza = `Freno${ref} antes de definirlo. Si ya está decidido, dejalo escrito en el issue y sigo solo.`;
    return lista ? `${cabeza} Lo que vi: el issue ${lista}.` : cabeza;
}

/**
 * UX-2 — pregunta que lee el operador, acotada a `MAX_PREGUNTA_OPERADOR`.
 *
 * El tope no es cosmético: la ficha de decisión cita la pregunta LITERAL y, si
 * no entra, degrada a "no supe clasificar" — un aviso peor que uno con menos
 * detalle. Se agregan preguntas mientras entren, y siempre entra al menos una.
 */
function buildOperatorQuestion(keys) {
    const prefijo = 'Antes de que el pipeline elija por su cuenta:';
    const preguntas = keys
        .map((k) => (SIGNAL_COPY[k] || {}).pregunta)
        .filter(Boolean);
    if (!preguntas.length) return `${prefijo} ¿qué querés que haga con esto?`;
    let out = `${prefijo} ${preguntas[0]}`;
    for (const p of preguntas.slice(1)) {
        const cand = `${out} ${p}`;
        if (cand.length > MAX_PREGUNTA_OPERADOR) break;
        out = cand;
    }
    return out;
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
 *     fragment,                // #6448 — cita del body que disparó la señal
 *     note                     // CA-4b: por qué se dejó pasar, para el log
 *   }
 *
 * @param {object} args
 * @param {string} [args.title]
 * @param {string} [args.body]
 * @param {Array}  [args.labels]
 * @param {number} [args.issue]
 * @param {object} [args.signoff] — #6448, veredicto YA RESUELTO de
 *   `evaluateArchitectSignoff()`. Opcional: sin él el comportamiento es el
 *   histórico exacto (CA-15).
 */
function detectDesignDecision({ issue, title = '', body = '', labels = [], signoff = null } = {}) {
    const base = { escalate: false, signals: [], reason: '', question: '', recommendation: '', fragment: '', note: '' };
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

    // #6448 CA-17 — la cita del body que disparó la PRIMERA señal. Va en campo
    // propio (UX-1) y nunca lanza: si el cálculo falla, el aviso sale igual.
    let fragmento = '';
    try { fragmento = signalFragment(segmentos, matched[0]); } catch { fragmento = ''; }

    // #6448 A-3 — la firma se evalúa ACÁ, después de `matched` y antes de armar
    // el escalado. Ponerla arriba obligaría al caller a consultar la red en el
    // camino feliz, que es exactamente lo que CA-12 prohíbe.
    if (signoff && signoff.settled === true) {
        return {
            ...base,
            signals: keys,
            fragment: fragmento,
            note: `firma del arquitecto cierra la decisión — se deja pasar (${signoff.reason})`,
        };
    }

    return {
        escalate: true,
        signals: keys,
        // UX-2/UX-3 — copy del operador: acción primero, frases en castellano,
        // sin keys internas (esas van al log y a la traza, CA-20/CA-27).
        reason: buildOperatorReason(issue, keys),
        question: buildOperatorQuestion(keys),
        recommendation: 'Dejá la decisión escrita en el issue, con las opciones y la elegida. Si queda implícita, el paso siguiente la vuelve a asumir sin avisarte.',
        fragment: fragmento,
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
    // #6448
    SIGNAL_COPY,
    MAX_SENALES_EN_COPY,
    MAX_PREGUNTA_OPERADOR,
    FRAGMENT_MAX,
    AGENT_FOOTER_RE,
    ARCHITECT_SKILL_ID,
    SIGNOFF_REJECT,
    cooccurrenceIndex,
    signalFragment,
    skillsDeclarados,
    evaluateArchitectSignoff,
    buildOperatorReason,
    buildOperatorQuestion,
};
