'use strict';

// =============================================================================
// decision-card.js — FUENTE ÚNICA del copy de la "ficha de decisión" (#6190,
// split de #6173).
//
// POR QUÉ EXISTE ESTE MÓDULO
// --------------------------
// El aviso de bloqueo le mandaba al operador datos sueltos del pipeline, no una
// decisión. Salida REAL medida el 19/08 (H-UX-2 del contrato de `ux`):
//
//     📋 Incidentes bloqueados esperando humano (3)
//     • #6173 — ux en criterios (3h)
//        ↳ dependency_block: espera #6110
//     • #6144 — po en criterios (30min)
//     • #6150 — guru en analisis (27h)
//     Usá /unblock <issue> <orientación> para desbloquear.
//
// Cuatro defectos en una sola salida: `ux en criterios` es vocabulario de
// máquina, `dependency_block: espera #6110` es un dato crudo sin traducir,
// #6150 llega SIN NINGUNA razón, y no hay una sola consecuencia ni costo de no
// decidir. El operador no puede decidir con eso.
//
// La ficha responde SIEMPRE seis preguntas: qué está frenado, por qué, qué se
// decide, qué opciones hay (con su consecuencia), qué evidencia hay, y qué pasa
// si no se decide.
//
// FUENTE ÚNICA (R-7). Este módulo unifica cuatro catálogos que hoy viven
// dispersos y describen lo mismo:
//   · `MOTIVOS`            — `views/dashboard/bloqueados.js`
//   · `TRIGGERS`           — `lib/human-block-triggers.js`
//   · `REASON_CATEGORIES`  — `connectivity-state.js`
//   · `ACTION_META`        — `lib/human-block.js`
// Mientras #6191 (dashboard) y #6192 (gate de firma) sigan bloqueadas, `MOTIVOS`
// y esta tabla conviven describiendo lo mismo. Es transitorio y esperado:
// NO EXTIENDAS `MOTIVOS` — el copy nuevo se agrega acá y los renderers lo leen.
//
// CONTRATO
// --------
// Módulo PURO: sin `fs`, sin red, sin `require` de estado del pipeline, sin
// `Date.now()` (el "ahora" se inyecta como `nowMs`). Única excepción a la
// pureza: el import de `redactAll`, que es la frontera de redacción de secretos
// (ver "Redacción" abajo).
//
// **Devuelve DATOS, nunca Markdown ni HTML.** Cada superficie (Telegram, audio
// TTS, dashboard) dibuja a su manera. Lo compartido es QUÉ decir, no CÓMO
// dibujarlo. Si aparece un `*`, un `<b>` o un `\n` de layout acá, está mal.
//
// REDACCIÓN DE SECRETOS — la frontera vive ACÁ, no en los renderers
// ----------------------------------------------------------------
// Todo campo string de la ficha sale por `sec()`, que aplica `redactAll` de
// `sherlock-audit-jsonl.js`. Es la función canónica (PAT fine-grained +
// `redactReadOutput` + `redactSecretValue`) y la que ya usaba el camino de
// audio. `redactSensitive` de `lib/redact.js` NO alcanza: sólo cubre URLs y
// emails y deja pasar AWS keys y JWT enteros (verificado).
//
// Cobertura verificada empíricamente contra HEAD:
//     AKIAIOSFODNN7EXAMPLE                 → [REDACTED]
//     Authorization: Bearer eyJ....        → [REDACTED]
//     ghp_xxxxxxxx...                      → [REDACTED]
//     leito@intrale.com                    → le***@in***.com  (enmascarado
//                                            PARCIAL: no afirmar cobertura
//                                            total de emails)
//     .pipeline/desarrollo/dev/...         → NO lo toca  ← por eso existe
//                                            `hard()`, abajo.
//
// TRES NIVELES DE SANEAMIENTO (el orden importa)
// ----------------------------------------------
//   1. `sec()`  — SIEMPRE, en todos los campos. Neutraliza saltos de línea y
//      caracteres de control (R-3: el título es input no confiable y podría
//      fabricar líneas falsas que imiten la estructura del mensaje), redacta
//      secretos, y neutraliza metacaracteres de Markdown/HTML (contrato
//      anti-#5421: NINGÚN campo de NINGUNA ficha puede emitir markup).
//   2. `hard()` — sobre texto externo. Saca lo que los CA prohíben de forma
//      dura: rutas del pipeline, nombres de archivo/módulo, labels internos y
//      claves `snake_case`.
//   3. `soft()` — sobre texto que la ficha REDACTA a partir de lo externo.
//      Saca el vocabulario de máquina de la lista negra de CA-B2.
//
// Qué nivel recibe cada cosa:
//   · copy de plantilla        → escrito a mano sin jerga (no necesita 2 ni 3)
//   · `que_esta_frenado.titulo`→ 1 solamente. H-UX-4: el 21,5 % de los títulos
//     abiertos contiene jerga LEGÍTIMAMENTE (#6121 «Purgar los worktrees
//     residuales de .pipeline/_tmp»). El título es el identificador que el
//     operador reconoce: se cita literal entre «comillas angulares» y
//     atribuido, nunca fusionado con lo que redacta el pipeline (R-3).
//   · pregunta literal de un agente → 1 + 2. No es un identificador que el
//     operador reconozca, así que una ruta o un label ahí sí se van; pero no se
//     parafrasea (UX §1.8), así que la jerga blanda se respeta.
//   · `evidencia_minima[]` y todo texto derivado → 1 + 2 + 3.
//
// LAS OPCIONES NUNCA SE INTERPOLAN DESDE TEXTO EXTERNO (R-4)
// ----------------------------------------------------------
// Ningún campo de `opciones[]` sale de `reason`, `question`, el título ni la
// evidencia. Sólo de esta tabla congelada, con números de issue ya validados
// como enteros. Si se interpolara, un tercero pasaría a redactar la opción que
// el operador percibe como recomendada POR EL PIPELINE, y el pie de destrabe
// sugeriría un valor de origen externo que termina en el prompt del agente.
// `evidencia_minima[]` es el ÚNICO campo que transporta texto externo.
//
// `marker_path` NO SE LEE NUNCA. Es una ruta del pipeline y ningún campo de la
// ficha puede contenerla.
// =============================================================================

const { redactAll } = require('./sherlock-audit-jsonl');

// -----------------------------------------------------------------------------
// Caps de longitud (CA-A2 / UX §1.6).
//
// No es capricho de Telegram: los MISMOS campos alimentan el guion de audio
// TTS, que tiene tope de 600 chars. Sin cap por campo el audio se corta a mitad
// de frase. El cap de 600 es política del renderer de audio, no de la ficha.
// -----------------------------------------------------------------------------
const MAX_CAMPO = 220;      // cap duro de cualquier campo string
const MAX_EVIDENCIA = 120;  // cada ítem de evidencia
const MAX_TITULO = 120;     // el título citado
const MAX_PREGUNTA_LITERAL = 160; // UX §4.6: más largo que esto → indeterminado
const MAX_EVIDENCIAS = 3;   // UX §1.5: máximo 3 ítems

const TIPOS = Object.freeze([
    'dependencia', 'circuit', 'firma', 'infra', 'rebote', 'pregunta', 'indeterminado',
]);

/**
 * `Object.freeze` es SUPERFICIAL y `opciones` es un array de objetos anidados:
 * un freeze de un nivel no impide que un consumidor mute `es_recomendada` o
 * `etiqueta` después de construida la ficha — y esos dos campos son justamente
 * los que el operador lee como "el pipeline me recomienda esto". Si la tabla se
 * declara inmutable, que lo sea de verdad. (Hallazgo compartido `guru` §6 /
 * `security` §4.)
 */
function deepFreeze(o) {
    if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return o;
    if (Object.isFrozen(o)) return o;
    Object.freeze(o);
    for (const k of Object.getOwnPropertyNames(o)) {
        try { deepFreeze(o[k]); } catch (_) { /* getters exóticos: no rompen el freeze */ }
    }
    return o;
}

// =============================================================================
// Nivel 1 — SEC. Se aplica SIEMPRE, a todos los campos.
// =============================================================================

// Metacaracteres de énfasis/código de Markdown legacy: los que rompen el parseo
// de Telegram si quedan desbalanceados y hacen perder el aviso con un HTTP 400
// que nadie ve (#5421: el saliente es fire-and-forget vía dropfile). Se
// neutralizan en el ORIGEN — así ningún renderer puede reintroducir la clase de
// bug por descuido. Los `<>` se van por el mismo motivo del lado HTML.
const MARKUP_BORRAR_RE = /[*`<>]/g;
const MARKUP_ESPACIO_RE = /_/g;
// El vector de phishing clickeable: `](` arma un link Markdown. Se parte con un
// espacio en vez de borrar, para no mutilar títulos como «[Split de #6173]».
const MARKDOWN_LINK_RE = /\]\(/g;

// R-3, segunda mitad del vector de phishing. Neutralizar `](` no alcanza: en
// TEXTO PLANO los clientes de Telegram auto-enlazan las URLs desnudas, así que
// un `https://evil.tld` suelto en el título de un issue —y el repo es público,
// el título lo escribe cualquiera— llega clickeable al operador dentro de un
// aviso que él lee como si lo hubiera escrito el pipeline.
//
// Se marca en vez de borrar en silencio: si el texto original traía un enlace,
// que se note que había uno y que lo sacamos nosotros.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Sin paréntesis propios: la marca puede caer justo dentro de un `](…)` que
// venía en el texto, y sumar los suyos deja un `((enlace omitido)` ilegible.
const URL_MARCA = 'enlace omitido';

// Saltos de línea y caracteres de control → espacio. R-3: sin esto un título
// hostil puede fabricar líneas falsas que imiten la estructura del mensaje
// ("Opciones:", "Para decidir, respondé: ...") y el operador no distingue lo
// que dice el pipeline de lo que escribió un tercero en un repo público.
//
// Se expresa como rangos de code point en vez de un literal de regex a
// propósito: un literal con caracteres de control CRUDOS en el fuente es
// invisible al leer el diff y frágil ante cualquier herramienta que normalice
// el archivo (de hecho rompió el parseo del módulo la primera vez). Los rangos
// son C0, C1, las marcas invisibles de ancho cero y dirección, los separadores
// de línea y párrafo de Unicode, y el BOM.
//
// rev-2 / SEC-B: la tabla decía cubrir "las marcas de dirección" pero paraba en
// 0x200F, y ahí está lo peligroso de verdad. U+202E (RLO) es una orden de
// "mostrá todo al revés de acá en adelante": el atacante escribe el texto dado
// vuelta y en pantalla se lee derecho, pero el vuelco ARRASTRA al texto que el
// pipeline puso después, así que el operador puede leer una cosa y decidir
// sobre otra. Los aislantes U+2066-U+2069 hacen lo mismo acotado a un rango.
// No hay título legítimo que los necesite; van al mismo saco que el salto de
// línea. ÚNICA tabla del módulo: el renderer la importa en vez de copiarla —
// dos copias divergen y ese fue justo el defecto de esta rev.
const CONTROL_RANGES = deepFreeze([
    [0x00, 0x1F],     // C0: incluye salto de línea, retorno de carro y tab
    [0x7F, 0x9F],     // DEL + C1
    [0x200B, 0x200F], // ancho cero + marcas de dirección
    [0x202A, 0x202E], // LRE/RLE/PDF/LRO/RLO: anulación de dirección
    [0x2028, 0x2029], // LINE SEPARATOR / PARAGRAPH SEPARATOR
    [0x2066, 0x2069], // LRI/RLI/FSI/PDI: aislantes de dirección
    [0xFEFF, 0xFEFF], // BOM
]);

function sinControles(s) {
    let out = '';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        let esControl = false;
        for (const [a, b] of CONTROL_RANGES) {
            if (c >= a && c <= b) { esControl = true; break; }
        }
        out += esControl ? ' ' : ch;
    }
    return out;
}

/** Corta en el último espacio antes del cap para no partir una palabra. */
function truncar(s, max) {
    if (s.length <= max) return s;
    const duro = s.slice(0, max - 1);
    const corte = duro.lastIndexOf(' ');
    const base = corte > max * 0.6 ? duro.slice(0, corte) : duro;
    return base.replace(/[\s,;:.]+$/, '') + '…';
}

/**
 * Nivel 1: control chars → redacción de secretos → neutralización de markup →
 * colapso de espacios → cap. En ese orden: redactar ANTES de truncar (truncar
 * primero podría dejar la mitad de una credencial visible).
 */
function sec(value, max = MAX_CAMPO) {
    if (value == null) return '';
    let s = String(value);
    if (!s) return '';
    s = sinControles(s);
    s = String(redactAll(s));
    s = s.replace(URL_RE, URL_MARCA);
    s = s.replace(MARKDOWN_LINK_RE, '] (')
        .replace(MARKUP_BORRAR_RE, '')
        .replace(MARKUP_ESPACIO_RE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return truncar(s, max);
}

// =============================================================================
// Nivel 2 — HARD. Lo que los CA prohíben de forma dura en el mensaje:
// "nombres de archivos de estado, labels internos, contadores crudos ni rutas
// del pipeline".
// =============================================================================

const HARD_RE = [
    // Rutas del pipeline y cualquier ruta con separador + extensión conocida.
    /(?:\.\/)?\.pipeline\/[^\s,;)]*/gi,
    /\b[\w.@-]+\/[\w./@-]*\.(?:js|json|ya?ml|md|log|kt|sh|txt)\b/gi,
    // Nombres de módulo sueltos: `pulpo.js`, `human-block.js`, `config.yaml`.
    /\b[\w-]+\.(?:js|json|ya?ml|md|log|kt|sh)\b/gi,
    // Labels internos de GitHub y del pipeline.
    /\b(?:needs-human|needs-definition|qa:[a-z-]+|blocked:[a-z-]+|area:[a-z-]+|priority:[a-z-]+|size:[a-z-]+|app:[a-z-]+|tipo:[a-z-]+)\b/gi,
    // Claves `snake_case` (`dependency_block`, `motivo_rechazo`, `age_hours`).
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
];

function hard(s) {
    let out = s;
    for (const re of HARD_RE) out = out.replace(re, ' ');
    return out.replace(/\s+([,;.:])/g, '$1').replace(/\s+/g, ' ').trim();
}

// =============================================================================
// Nivel 3 — SOFT. Lista negra de vocabulario de máquina (CA-B2, glosario del
// contrato de `ux` §3). Sólo sobre texto que la ficha redacta a partir de lo
// externo — NUNCA sobre el título citado (H-UX-4).
// =============================================================================

// PRIMERO traducir, después borrar. El nombre de una fase o de un agente SÍ
// aporta a la decisión ("lo devolvió el control de calidad" no es lo mismo que
// "lo devolvió la revisión de código"): borrarlo pierde información que el
// operador necesita. Lo que no aporta —`dispatch`, `tick`, `worktree`— se borra.
// H-UX-2 midió el costo de no traducir: `ux en criterios` / `guru en analisis`
// es vocabulario de máquina que el operador no puede accionar.
const SOFT_TRADUCCIONES = Object.freeze([
    [/\bverificaci[óo]n\b/gi, 'el control de calidad'],
    [/\baprobaci[óo]n\b/gi, 'la revisión de código'],
    [/\bvalidaci[óo]n\b/gi, 'los criterios'],
    [/\b(?:criterios|an[áa]lisis|analisis|sizing)\b/gi, 'la definición'],
    [/\bbuild\b/gi, 'la compilación'],
    [/\bneeds-human\b/gi, 'esperando tu decisión'],
    [/\bblocked:dependencies\b/gi, 'esperando otro trabajo'],
    [/\bcircuit\s*breakers?\b/gi, 'se agotaron los intentos'],
]);

const SOFT_RE = [
    /\bgate\s*[12]\b/gi,
    /\bdry[-\s]?run\b/gi,
    /\bfail[-\s]?closed\b/gi,
    /\b(?:dispatch|tick|ticks|barrido|worktrees?|override|dedupe|payload|dropfile|enforce|stale|backlog|skill|pulpo|yaml)\b/gi,
    /\bre(?:bote|botes|botar)\b/gi,
    /\bfases?\b/gi,
    /\b(?:commit|commits|hash|HEAD)\b/g,
];

function soft(s) {
    let out = s;
    for (const [re, texto] of SOFT_TRADUCCIONES) out = out.replace(re, texto);
    for (const re of SOFT_RE) out = out.replace(re, ' ');
    return out.replace(/\s+([,;.:])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Texto externo íntegro: SEC + HARD + SOFT. Es lo que va a `evidencia_minima`. */
function externo(value, max = MAX_EVIDENCIA) {
    const base = soft(hard(sec(value, MAX_CAMPO)));
    return base ? truncar(base, max) : '';
}

/** Texto citado literal de un agente: SEC + HARD (no se parafrasea, UX §1.8). */
function citado(value, max = MAX_CAMPO) {
    const base = hard(sec(value, MAX_CAMPO));
    return base ? truncar(base, max) : '';
}

// =============================================================================
// Antigüedad — tabla de redacción de `{edad}` (contrato de `ux` §5).
//
// Una sola forma por rango, sin decimales. El "ahora" se INYECTA (CA-A6): la
// antigüedad se calcula sin depender del reloj real, así el test es
// determinístico y dos `nowMs` distintos dan dos textos distintos.
//
// "No calculable" devuelve '' y el renderer omite la frase entera: nunca
// `hace NaN` ni `hace 0 min`.
// =============================================================================
function edadDesdeMinutos(min) {
    if (!Number.isFinite(min) || min < 0) return '';
    const m = Math.floor(min);
    if (m < 1) return 'recién';
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return rm > 0 ? `hace ${h} h ${rm} min` : `hace ${h} h`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `hace ${d} d ${rh} h` : `hace ${d} d`;
}

function edadDesdeHoras(horas) {
    if (!Number.isFinite(horas) || horas < 0) return '';
    return edadDesdeMinutos(horas * 60);
}

/**
 * Antigüedad preferentemente calculada desde `blocked_at` con el `nowMs`
 * inyectado; si el marker no trae timestamp, degrada a `age_hours` (y entonces
 * `nowMs` no influye, que es lo honesto: el dato ya venía pre-calculado).
 */
function edadDeBloqueo(raw, nowMs) {
    const ts = Date.parse(raw.blocked_at);
    if (Number.isFinite(ts) && Number.isFinite(nowMs)) {
        const min = (nowMs - ts) / 60000;
        if (min >= 0) return edadDesdeMinutos(min);
    }
    return edadDesdeHoras(raw.age_hours);
}

// =============================================================================
// Glosario operador (contrato de `ux` §2). Traducción obligatoria de los
// nombres internos de fase a algo que el operador pueda accionar.
// =============================================================================
const FASE_LEGIBLE = deepFreeze({
    verificacion: 'calidad',
    build: 'compilación',
    aprobacion: 'revisión de código',
    validacion: 'criterios',
    criterios: 'definición',
    analisis: 'definición',
    sizing: 'definición',
    dev: 'desarrollo',
    entrega: 'entrega',
});

const ROL_LEGIBLE = deepFreeze({
    'android-dev': 'el desarrollo de la app',
    'backend-dev': 'el desarrollo del servidor',
    'web-dev': 'el desarrollo de la web',
    'pipeline-dev': 'el desarrollo del pipeline',
    po: 'la definición de producto',
    ux: 'el diseño de experiencia',
    qa: 'el control de calidad',
    tester: 'el control de calidad',
    review: 'la revisión de código',
    architect: 'la arquitectura',
    guru: 'la investigación técnica',
});

function faseLegible(fase) {
    const k = String(fase || '').trim().toLowerCase();
    return FASE_LEGIBLE[k] || '';
}

function rolLegible(skill) {
    const k = String(skill || '').trim().toLowerCase();
    return ROL_LEGIBLE[k] || '';
}

// =============================================================================
// Normalización de la entrada.
//
// Forma de `raw`: la que ya produce `listBlockedIssues()`
// (`{ issue, skill, phase, pipeline, reason, question, precondition,
//     blocked_at, age_hours, marker_path }`), más los campos opcionales de
// contexto que los call-sites pueden enriquecer. Todos son opcionales: sin
// ellos la ficha degrada a "no hay recomendación, y te digo por qué".
// =============================================================================

function entero(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 10000000 ? n : null;
}

function numero(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function booleano(v) {
    return v === true ? true : (v === false ? false : null);
}

/** Extrae los números de issue de los que depende este trabajo. */
function leerDeps(raw) {
    const out = [];
    const push = (v) => { const n = entero(v); if (n && !out.includes(n)) out.push(n); };
    if (Array.isArray(raw.deps)) raw.deps.forEach(push);
    push(raw.dep);
    // `dependency_block` estructurado (el shape que hoy escribe el pulpo) y el
    // texto libre `espera #6110`. Se leen los NÚMEROS, nunca el texto: lo que
    // sale a la ficha es un entero validado, no una interpolación externa.
    for (const campo of [raw.reason, raw.question]) {
        const t = campo == null ? '' : String(campo);
        if (!t) continue;
        if (t.trim()[0] === '{' || t.trim()[0] === '[') {
            try {
                const obj = JSON.parse(t.slice(0, 4000));
                const db = obj && obj.dependency_block;
                if (Array.isArray(db)) db.forEach(push);
                else if (db != null) push(db);
                if (Array.isArray(obj && obj.deps)) obj.deps.forEach(push);
            } catch (_) { /* texto que sólo parece JSON: se ignora */ }
        }
        const m = t.match(/#(\d{1,7})/g);
        if (m && /depend|espera|bloquead[oa] por|waiting/i.test(t)) {
            m.forEach((x) => push(x.slice(1)));
        }
    }
    return out;
}

function normalizar(raw, nowMs) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const issue = entero(d.issue != null ? d.issue : d.number);
    const deps = leerDeps(d).filter((n) => n !== issue);
    return {
        issue,
        // El título es lo único que se cita literal (SEC solamente).
        titulo: sec(d.titulo != null ? d.titulo : d.title, MAX_TITULO),
        skill: String(d.skill || ''),
        phase: String(d.phase || d.fase || ''),
        reason: d.reason == null ? '' : String(d.reason),
        question: d.question == null ? '' : String(d.question),
        // #5337 CA-2 — la sugerencia que ya calculó el pipeline (triggers,
        // clasificador de rechazos). NO es una opción y NO se marca como
        // recomendada: R-4 exige que `opciones[]` salga sólo de la tabla
        // congelada. Va como línea aparte, atribuida al pipeline, para que el
        // operador sepa de dónde sale — y para que el aviso no pierda un dato
        // que hoy sí muestra.
        sugerencia: externo(d.recommendation, MAX_CAMPO),
        labels: (Array.isArray(d.labels) ? d.labels : []).map((x) => String(x).toLowerCase()),
        tipo: TIPOS.includes(d.tipo) ? d.tipo : null,
        edad: edadDeBloqueo(d, nowMs),
        // Contexto opcional. Todos degradan a `null` → "sin recomendación".
        deps,
        depTitulo: sec(d.dep_titulo, MAX_TITULO),
        depEdad: edadDesdeHoras(numero(d.dep_age_hours)),
        depHoras: numero(d.dep_age_hours),
        dependientes: entero(d.dependientes),
        rebotes: entero(d.rebotes),
        rebotesMax: entero(d.rebotes_max) || 3,
        rebotesMismoMotivo: booleano(d.rebotes_mismo_motivo),
        ultimoRechazoEdad: edadDesdeHoras(numero(d.ultimo_rechazo_age_hours)),
        rechazoFase: faseLegible(d.rechazo_fase || d.phase),
        compilo: booleano(d.compilo),
        criteriosTotal: entero(d.criterios_total),
        firmaVencida: booleano(d.firma_vencida) === true,
        firmantesAutorizados: d.firmantes_autorizados == null ? null : Number(d.firmantes_autorizados),
        autores: (Array.isArray(d.autores) ? d.autores : []).map((x) => rolLegible(x)).filter(Boolean),
        fechaCorta: sec(d.fecha_corta, 40),
        reasonCategory: String(d.reason_category || '').trim().toLowerCase(),
        conexionRestablecida: booleano(d.conexion_restablecida),
        alternativoConCuota: booleano(d.alternativo_con_cuota),
        frenadosPorLoMismo: entero(d.frenados_por_lo_mismo),
        primerFalloEdad: edadDesdeHoras(numero(d.primer_fallo_age_hours)),
        ultimoIntentoEdad: edadDesdeHoras(numero(d.ultimo_intento_age_hours)),
        rol: rolLegible(d.skill),
        tarea: faseLegible(d.phase),
    };
}

// =============================================================================
// Clasificador `raw → tipo`.
//
// Prioridad: dependencia > circuit > infra > firma > rebote > pregunta >
// indeterminado. La señal más específica gana; el default es `indeterminado`,
// que es el honesto: mejor decir "no sé qué hay que decidir" que inventar tres
// opciones genéricas (CA-A5).
//
// `indeterminado` NO se inventa: `human-block-triggers.js` ya tiene contrato de
// 3 valores — objeto / `{ inconclusive: true }` / `null`. `inconclusive` mapea
// directo a `card.indeterminado === true`.
// =============================================================================
const RE_CIRCUIT = /circuit|breaker|circuito|rebotes agotados|3\s*rebote|m[áa]x.*rebote|max.*bounce|tope de rebote/i;
const RE_INFRA = /sin salida a internet|network[_\s-]?unreachable|backend[_\s-]?timeout|backend[_\s-]?5xx|rate[_\s-]?limit|auth[_\s-]?failure|proveedor|provider|cuota|quota|timeout|502|503|504|credencial rechazada|sin conectividad/i;
const RE_FIRMA = /gate\s*1|firma de definici|sin firmar|firmante|visto bueno|aprobaci[óo]n del alcance|pendiente de firma/i;
const RE_REBOTE = /rebote|rechaz|motivo_rechazo|reintent|bounce|devuelto por/i;
const RE_DEP = /dependency[_\s]block|dependencia|depende de|bloqueado por #|esperando.*#\d/i;

const INFRA_CATEGORIAS = Object.freeze([
    'network_unreachable', 'backend_timeout', 'backend_5xx', 'rate_limit', 'auth_failure',
]);

function clasificar(n) {
    if (n.tipo) return n.tipo;
    const txt = `${n.reason} ${n.question}`;
    const hayTexto = txt.trim().length > 0;

    // CA-A5 — "el motivo llegó vacío" es el caso MÁS FRECUENTE hoy (#6150 en la
    // medición de H-UX-2). Es indeterminado, no un tipo genérico.
    if (!hayTexto) return 'indeterminado';

    if (n.deps.length > 0 || RE_DEP.test(txt)) {
        // "Dice que espera algo pero no dice qué": sin número de dependencia no
        // se puede proponer "esperar a que cierre #N".
        return n.deps.length > 0 ? 'dependencia' : 'indeterminado';
    }
    if (RE_CIRCUIT.test(txt)) return 'circuit';
    // `unknown` NO usa la plantilla de infra: cae en indeterminado (UX §4.4).
    if (INFRA_CATEGORIAS.includes(n.reasonCategory)) return 'infra';
    if (n.reasonCategory === 'unknown') return 'indeterminado';
    if (RE_INFRA.test(txt)) return 'infra';
    if (RE_FIRMA.test(txt) || n.labels.includes('needs-definition')) {
        // CA-A3 — si el gate retiene porque NO HAY firmante autorizado, pedirle
        // al operador que firme no tiene sentido: ninguna firma sería válida.
        return n.firmantesAutorizados === 0 ? 'indeterminado' : 'firma';
    }
    if (RE_REBOTE.test(txt)) {
        // Rebotes agotados vs. una vuelta más: el contador decide.
        return (n.rebotes != null && n.rebotes >= n.rebotesMax) ? 'circuit' : 'rebote';
    }
    if (esPreguntaUsable(n)) return 'pregunta';
    return 'indeterminado';
}

/**
 * UX §4.6: la pregunta de un agente se cita LITERAL — parafrasearla la cambia.
 * Sólo es usable si de verdad es una pregunta (termina en `?`) y entra en el
 * mensaje (≤160). Si no, la ficha no la puede mostrar y cae en indeterminado
 * antes que mutilarla.
 */
function esPreguntaUsable(n) {
    const q = citado(n.question, MAX_PREGUNTA_LITERAL + 1);
    return q.length > 0 && q.length <= MAX_PREGUNTA_LITERAL && q.endsWith('?');
}

// =============================================================================
// Cola del comando de destrabe cuando NO hay un valor concreto que el operador
// pueda pegar tal cual (#6190, rebote rev-1).
//
// El pie de destrabe dejó de ser un molde en el NÚMERO (`<issue>` → 6150), pero
// en `pregunta` e `indeterminado` seguía siendo un molde en el VALOR
// (`qué-hacer`, `tu-respuesta`): son marcadores de posición, no orientaciones.
// Y no son inofensivos: `cmdUnblock` los acepta como orientación válida, se
// persisten en `<marker>.guidance.txt` y terminan inyectados en el prompt del
// agente bajo el rótulo "INDICACIONES HUMANAS … NO la ignores". O sea: pegar el
// pie tal cual destraba el issue con una indicación que nadie escribió.
//
// Cuando el valor lo tiene que escribir el operador, el pie lo dice con
// palabras en vez de fingir un valor. Es la misma redacción que ya usaba el
// fallback (`FALLBACK.cierre`), que se arma desde acá para que haya UNA sola.
// =============================================================================
const ORIENTACION_LIBRE = 'seguido de qué querés que se haga';

/**
 * Moldes históricos del pie de destrabe (#6190 rev-1) + la propia frase de
 * `ORIENTACION_LIBRE`. Ninguno es una orientación: son texto del aviso.
 */
const MOLDES_DE_ORIENTACION = deepFreeze([
    ORIENTACION_LIBRE,
    'qué-hacer',
    'tu-respuesta',
    'orientación',
    'issue',
]);

/**
 * ¿Este texto es el molde del aviso pegado tal cual, en vez de una orientación?
 *
 * Guarda del lado del comando: el pie sin valor de ejemplo se lee bien pero se
 * puede copiar entero, y `unblockIssue` lo persistiría en
 * `<marker>.guidance.txt`, desde donde el pulpo lo inyecta al prompt del agente
 * bajo "INDICACIONES HUMANAS … NO la ignores". Es exactamente la cadena que
 * describe el rechazo: rechazarlo acá cierra el paso aunque el copy vuelva a
 * cambiar.
 *
 * Compara normalizado (sin acentos, sin `<>`, sin puntuación de borde) para que
 * no dependa de cómo se pegó.
 * @param {string} texto
 * @returns {boolean}
 */
function esOrientacionMolde(texto) {
    const norm = (t) => String(t == null ? '' : t)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[<>`*_"'.,;:!?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const t = norm(texto);
    if (!t) return false;
    return MOLDES_DE_ORIENTACION.some((m) => norm(m) === t);
}

// =============================================================================
// Tabla de copy `tipo → plantilla`. Literal del contrato de `ux` §4.
//
// R-4: ningún texto de acá se interpola desde `reason`, `question`, el título ni
// la evidencia. Sólo enteros ya validados y textos de antigüedad derivados de
// números. Congelada en profundidad.
// =============================================================================
const COPY = deepFreeze({
    dependencia: {
        por_que: 'No puede avanzar hasta que se cierre otro trabajo del que depende.',
        costo_solo: 'no avanza y sigue ocupando lugar en la ola.',
        costo_con_dependientes: 'y los trabajos que dependen de él no avanzan.',
        ejemplo: 'esperar',
    },
    circuit: {
        por_que_mismo: 'Se intentó {n} veces y las {n} volvió rechazado por el mismo control.',
        por_que_distinto: 'Se intentó {n} veces y las {n} volvió rechazado.',
        que_se_decide: '¿Le damos otra vuelta a {ref} con una indicación tuya, o lo damos de baja?',
        costo: 'Sigue ocupando uno de los tres lugares de trabajo simultáneo.',
        ejemplo: 'reintentar',
    },
    firma: {
        por_que: 'Está listo para arrancar, pero el alcance necesita tu visto bueno antes.',
        por_que_vencida: 'Ya lo habías firmado, pero los criterios cambiaron después de tu firma.',
        que_se_decide: '¿Aprobás el alcance de {ref} para que arranque el desarrollo?',
        que_se_decide_vencida: '¿Confirmás el alcance nuevo de {ref}, o lo mandás a replantear?',
        costo: 'Nada arranca. El trabajo queda listo pero parado, y no se te vuelve a avisar hasta que cambie lo que hay que firmar.',
        sin_reco: 'No hay recomendación: la decisión es tuya.',
        ejemplo: 'aprobar',
    },
    infra: {
        que_se_decide: '¿Reintentamos {ref} ahora, o lo pasamos a otro proveedor?',
        que_se_decide_credencial: '¿Renovás la credencial, o pasamos {ref} a otro proveedor?',
        costo_solo: 'Mientras tanto no avanza y nadie lo va a mover solo.',
        costo_varios: 'Los {n} trabajos frenados por lo mismo tampoco avanzan.',
        ejemplo: 'reintentar',
    },
    rebote: {
        por_que: 'El control de {fase} lo devolvió con observaciones.',
        por_que_sin_fase: 'Un control de calidad lo devolvió con observaciones.',
        que_se_decide: '¿Mandamos {ref} a corregir con lo observado, o el rechazo no aplica?',
        costo: 'No avanza y consume una de las tres vueltas antes de darse de baja solo.',
        sin_reco: 'No hay recomendación: el motivo del rechazo llegó vacío o ilegible.',
        ejemplo: 'corregir',
    },
    pregunta: {
        por_que: 'Un agente se trabó con una pregunta que no puede responder solo.',
        costo: 'El agente no sigue: el trabajo queda exactamente donde estaba.',
        sin_reco: 'No hay recomendación: la pregunta es sobre el producto y la respuesta la tenés vos.',
        // Sin valor de ejemplo A PROPÓSITO: la respuesta a la pregunta del
        // agente la escribe el operador. Ver `ORIENTACION_LIBRE`.
        ejemplo: '',
    },
    indeterminado: {
        por_que: 'Quedó frenado por algo que no supe clasificar.',
        que_se_decide: '¿Qué querés hacer con {ref}? No tengo el dato para proponerte opciones.',
        costo: 'Queda frenado por tiempo indefinido; nada lo va a mover solo.',
        falta_sin_motivo: 'El motivo del bloqueo. Quien lo frenó no dejó texto; el dato está en la actividad reciente del issue.',
        falta_dep_sin_numero: 'Qué trabajo está esperando: dice que espera algo pero no dice cuál.',
        falta_sin_firmante: 'No hay ningún firmante autorizado configurado: sin eso ninguna firma vale.',
        falta_ilegible: 'El motivo del bloqueo llegó ilegible o no entra en un aviso.',
        // Sin valor de ejemplo A PROPÓSITO: si no supe clasificar el bloqueo,
        // menos puedo proponer qué hacer con él. Ver `ORIENTACION_LIBRE`.
        ejemplo: '',
    },
});

const CORTO = deepFreeze({
    dependencia: '¿Esperamos o avanzamos igual?',
    circuit: '¿Se reintenta o se replantea el alcance?',
    firma: '¿Aprobás el alcance?',
    infra: '¿Esperamos que vuelva o paramos por hoy?',
    rebote: '¿Se corrige o se acepta como está?',
    pregunta: 'Un agente te hizo una pregunta.',
    indeterminado: 'No sé qué hay que decidir.',
});

// Las cuatro consecuencias de `ACTION_META` re-redactadas por `ux` (H-UX-5): las
// originales dicen "la cola del pipeline" (lista negra), están en 2ª persona
// —que choca con la voz de las consecuencias nuevas y produce una ficha con dos
// voces— y ninguna trae `razon_recomendacion`, copy que no existía en el repo.
//
// `consecuencia` va en TERCERA persona describiendo qué hace el SISTEMA
// ("Vuelve a la cola y sigue donde quedó"), no "Vas a…": la etiqueta ya es el
// verbo del operador y repetirlo suena a formulario (UX §1.1).
const OPCION = deepFreeze({
    esperar_dep: {
        etiqueta: 'Esperar a que cierre {refdep}',
        consecuencia: '{ref} queda en espera y arranca solo cuando {refdep} cierre. No hay que hacer nada más.',
    },
    esperar_deps: {
        etiqueta: 'Esperar a que cierren los {n} trabajos',
        consecuencia: '{ref} queda en espera y arranca solo cuando cierren. No hay que hacer nada más.',
    },
    avanzar_igual: {
        etiqueta: 'Avanzar igual, sin esperar',
        consecuencia: 'Arranca ahora. Si lo que esperaba hacía falta, este trabajo puede rehacerse después.',
    },
    sacar_de_ola: {
        etiqueta: 'Sacarlo del plan de esta ola',
        consecuencia: 'Vuelve a la lista de pendientes y deja de ocupar lugar en la ola. No se pierde nada de lo hecho.',
    },
    reintentar_indicacion: {
        etiqueta: 'Reintentar con una indicación tuya',
        consecuencia: 'Vuelve a la cola con tu texto como guía y el contador de intentos arranca de nuevo.',
    },
    devolver_definicion: {
        etiqueta: 'Devolverlo a definición',
        consecuencia: 'Se descarta el desarrollo hecho y se vuelve a analizar desde cero. Es la opción más costosa.',
    },
    dar_de_baja: {
        etiqueta: 'Darlo de baja',
        consecuencia: 'Se cierra sin hacer y lo desarrollado se descarta.',
    },
    aprobar_alcance: {
        etiqueta: 'Aprobar el alcance',
        consecuencia: 'Arranca el desarrollo con los criterios tal como están.',
    },
    rechazar_alcance: {
        etiqueta: 'Rechazar',
        consecuencia: 'No arranca. El alcance vuelve a replantearse desde el principio.',
    },
    ajustar_criterios: {
        etiqueta: 'Ajustar los criterios',
        consecuencia: 'No arranca todavía. Editás los criterios y el pedido vuelve con el texto nuevo.',
    },
    reintentar_ahora: {
        etiqueta: 'Reintentar ahora',
        consecuencia: 'Vuelve a intentarlo con el mismo proveedor. Si el problema sigue, vuelve a frenarse.',
    },
    pasar_alternativo: {
        etiqueta: 'Pasarlo al proveedor alternativo',
        consecuencia: 'Sigue con otro proveedor. Puede cambiar la calidad del resultado.',
    },
    esperar_servicio: {
        etiqueta: 'Dejarlo esperando a que el servicio vuelva',
        consecuencia: 'Queda frenado y reintenta solo cuando el proveedor conteste bien.',
    },
    renovar_credencial: {
        etiqueta: 'Renovar la credencial',
        consecuencia: 'Cargás la credencial nueva y el trabajo reintenta solo.',
    },
    mandar_corregir: {
        etiqueta: 'Mandarlo a corregir',
        consecuencia: 'Vuelve a desarrollo con las observaciones como guía.',
    },
    aprobar_igual: {
        etiqueta: 'Aprobarlo igual: el rechazo no aplica',
        consecuencia: 'Sigue de largo al paso siguiente. Si el rechazo tenía razón, el defecto llega al producto.',
    },
    replantear_alcance: {
        etiqueta: 'Devolverlo a definición',
        consecuencia: 'Se descarta el desarrollo hecho y se replantea el alcance.',
    },
    responder_pregunta: {
        etiqueta: 'Responder la pregunta',
        consecuencia: 'Tu respuesta vuelve al agente y el trabajo sigue donde quedó.',
    },
    pedir_contexto: {
        etiqueta: 'Pedirle más contexto',
        consecuencia: 'El agente explica mejor qué necesita. Queda frenado hasta que respondas.',
    },
    replantear_por_pregunta: {
        etiqueta: 'Devolverlo a definición',
        consecuencia: 'Se descarta lo hecho y se replantea el alcance. Sirve cuando la pregunta muestra que el pedido estaba mal planteado.',
    },
});

/**
 * Interpola SÓLO enteros validados y textos de antigüedad derivados de números.
 *
 * Un placeholder sin resolver colapsa a VACÍO, nunca se deja literal. Dejarlo es
 * el modo de falla que apareció en el primer ciclo: con un `raw` sin número de
 * issue el operador recibía "¿Qué querés hacer con {issue}?" — un aviso que se
 * lee como un bug del pipeline y erosiona la confianza en todos los demás.
 */
function interp(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : ''))
        .replace(/\s+([,;.:?!])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Cómo se nombra un trabajo dentro del copy.
 *
 * El número de issue es EL identificador que el operador reconoce, pero puede
 * faltar (un `raw` degradado, o un call-site que sólo tiene el motivo). En ese
 * caso el copy no puede quedar con un hueco ni con un `#null`: se lo nombra de
 * forma genérica, y la ficha pierde el pie de destrabe — sin número sería un
 * comando que el operador no puede ejecutar.
 */
function refIssue(issue) {
    return issue ? `#${issue}` : 'este trabajo';
}

/**
 * Arma una opción desde la tabla congelada. `es_recomendada` y
 * `razon_recomendacion` los decide el llamador con datos VERIFICADOS; si no hay
 * dato, la opción sale sin recomendar y la ficha declara por qué (CA-A4).
 */
function opcion(base, vars, reco) {
    return {
        etiqueta: sec(interp(base.etiqueta, vars), 48),
        consecuencia: sec(interp(base.consecuencia, vars), MAX_CAMPO),
        es_recomendada: reco != null,
        razon_recomendacion: reco != null ? sec(interp(reco, vars), MAX_CAMPO) : '',
    };
}

// =============================================================================
// Constructores por tipo. Cada uno devuelve
// `{ por_que, que_se_decide, opciones, evidencia, costo, sin_reco, ejemplo }`.
// =============================================================================

function fichaDependencia(n) {
    const dep = n.deps[0];
    const varias = n.deps.length > 1;
    const ref = refIssue(n.issue);
    const refdep = dep ? `#${dep}` : 'el trabajo que espera';
    const vars = { issue: n.issue, dep, ref, refdep, n: n.deps.length, edad_dep: n.depEdad };

    // ★ La recomendación se apoya en un HECHO verificable: la actividad reciente
    // de la dependencia. Sin ese dato NO se recomienda nada y se dice por qué —
    // una recomendación sin evidencia es peor que ninguna.
    let recoEsperar = null;
    let recoAvanzar = null;
    let sinReco = '';
    if (n.depHoras == null) {
        sinReco = varias
            ? 'No hay recomendación: no pude ver en qué andan los trabajos que espera.'
            : `No hay recomendación: no pude ver en qué anda ${refdep}.`;
    } else if (n.depHoras <= 48) {
        recoEsperar = varias
            ? 'Los trabajos que espera ya están en movimiento y cierran en esta misma ola.'
            : '{refdep} ya está en movimiento y cierra en esta misma ola.';
    } else if (n.depHoras >= 168) {
        recoAvanzar = varias
            ? 'Lo que espera está parado {edad_dep}: esperarlo frena esto por tiempo indefinido.'
            : '{refdep} está parado {edad_dep}: esperarlo frena esto por tiempo indefinido.';
    } else {
        sinReco = varias
            ? 'No hay recomendación: los trabajos que espera no muestran movimiento claro.'
            : `No hay recomendación: ${refdep} no muestra movimiento claro ni está parado del todo.`;
    }

    const evidencia = [];
    if (varias) {
        evidencia.push(`Los ${n.deps.length} trabajos que espera siguen abiertos`);
    } else if (n.depTitulo) {
        evidencia.push(`${refdep} «${n.depTitulo}» sigue abierto`);
    } else {
        evidencia.push(`${refdep} sigue abierto`);
    }
    if (n.depEdad) evidencia.push(`su última actividad fue ${n.depEdad}`);

    return {
        por_que: COPY.dependencia.por_que,
        que_se_decide: varias
            ? `¿Esperamos que cierren los ${n.deps.length} trabajos de los que depende ${ref}, o lo dejamos avanzar sin eso?`
            : `¿Esperamos que cierre ${refdep}, o dejamos que ${ref} avance sin eso?`,
        opciones: [
            opcion(varias ? OPCION.esperar_deps : OPCION.esperar_dep, vars, recoEsperar),
            opcion(OPCION.avanzar_igual, vars, recoAvanzar),
            opcion(OPCION.sacar_de_ola, vars, null),
        ],
        evidencia,
        costo: n.dependientes
            ? `${ref} ${COPY.dependencia.costo_con_dependientes}`
            : `${ref} ${COPY.dependencia.costo_solo}`,
        sin_reco: sinReco,
        ejemplo: COPY.dependencia.ejemplo,
    };
}

function fichaCircuit(n) {
    const veces = n.rebotes || n.rebotesMax;
    const vars = { issue: n.issue, ref: refIssue(n.issue), n: veces };

    let recoReintentar = null;
    let recoDevolver = null;
    let sinReco = '';
    if (n.rebotesMismoMotivo === true) {
        recoReintentar = 'Las {n} vueltas fallaron por lo mismo, así que alcanza una indicación puntual.';
    } else if (n.rebotesMismoMotivo === false) {
        recoDevolver = 'Cada vuelta falló por algo distinto: el problema está en el planteo, no en la ejecución.';
    } else {
        sinReco = 'No hay recomendación: no pude ver si las vueltas fallaron todas por lo mismo.';
    }

    const evidencia = [];
    if (n.ultimoRechazoEdad) {
        evidencia.push(n.rechazoFase
            ? `Último rechazo: ${n.ultimoRechazoEdad}, en el control de ${n.rechazoFase}`
            : `Último rechazo: ${n.ultimoRechazoEdad}`);
    }
    if (n.compilo === true) evidencia.push('Llegó a compilar: el rechazo no es de compilación');

    return {
        por_que: interp(
            n.rebotesMismoMotivo === false ? COPY.circuit.por_que_distinto : COPY.circuit.por_que_mismo,
            vars,
        ),
        que_se_decide: interp(COPY.circuit.que_se_decide, vars),
        opciones: [
            opcion(OPCION.reintentar_indicacion, vars, recoReintentar),
            opcion(OPCION.devolver_definicion, vars, recoDevolver),
            opcion(OPCION.dar_de_baja, vars, null),
        ],
        evidencia,
        costo: COPY.circuit.costo,
        sin_reco: sinReco,
        ejemplo: COPY.circuit.ejemplo,
    };
}

function fichaFirma(n) {
    const vars = { issue: n.issue, ref: refIssue(n.issue) };
    const evidencia = [];
    if (n.criteriosTotal) {
        evidencia.push(`Son ${n.criteriosTotal} criterios de aceptación y ninguno está firmado`);
    }
    if (n.fechaCorta) evidencia.push(`Retenido desde el ${n.fechaCorta}`);
    else if (n.edad) evidencia.push(`Retenido ${n.edad}`);
    if (n.autores.length) evidencia.push(`El alcance lo escribieron ${n.autores.join(' y ')}`);

    // Decisión de diseño de `ux`, sostenida y no re-litigable: el tipo `firma`
    // NUNCA lleva opción recomendada. Un gate cuyo propio pedido de firma
    // sugiere cómo firmar deja de ser un gate y pasa a ser un trámite de un
    // clic. CA-A4 dice "a lo sumo una": acá cero es lo correcto.
    return {
        por_que: n.firmaVencida ? COPY.firma.por_que_vencida : COPY.firma.por_que,
        que_se_decide: interp(
            n.firmaVencida ? COPY.firma.que_se_decide_vencida : COPY.firma.que_se_decide, vars,
        ),
        opciones: [
            opcion(OPCION.aprobar_alcance, vars, null),
            opcion(OPCION.rechazar_alcance, vars, null),
            opcion(OPCION.ajustar_criterios, vars, null),
        ],
        evidencia,
        costo: COPY.firma.costo,
        sin_reco: COPY.firma.sin_reco,
        ejemplo: COPY.firma.ejemplo,
    };
}

// Categoría de causa → por qué está frenado (UX §4.4). `unknown` NO está acá a
// propósito: cae en `indeterminado` antes de llegar a esta tabla.
const INFRA_POR_QUE = deepFreeze({
    network_unreachable: 'La máquina que corre el pipeline se quedó sin salida a internet.',
    backend_timeout: 'El proveedor de IA está tardando más de lo que se espera.',
    backend_5xx: 'El proveedor de IA está devolviendo errores.',
    rate_limit: 'El proveedor de IA está limitando el ritmo de pedidos.',
    auth_failure: 'El proveedor de IA no está aceptando las credenciales.',
});

function inferirCategoriaInfra(n) {
    if (INFRA_CATEGORIAS.includes(n.reasonCategory)) return n.reasonCategory;
    const t = `${n.reason} ${n.question}`;
    if (/credencial|auth[_\s-]?failure|unauthorized|401|403/i.test(t)) return 'auth_failure';
    if (/rate[_\s-]?limit|cuota|quota|429/i.test(t)) return 'rate_limit';
    if (/sin salida a internet|network|unreachable|dns|sin conectividad/i.test(t)) return 'network_unreachable';
    if (/5xx|502|503|504|error del proveedor/i.test(t)) return 'backend_5xx';
    return 'backend_timeout';
}

function fichaInfra(n) {
    const cat = inferirCategoriaInfra(n);
    const credencial = cat === 'auth_failure';
    const cuantos = n.frenadosPorLoMismo;
    const vars = { issue: n.issue, ref: refIssue(n.issue), n: cuantos, edad: n.ultimoIntentoEdad };

    let opciones;
    let sinReco = '';
    if (credencial) {
        // ★ En credencial rechazada la recomendación es siempre la misma y no
        // depende de ningún dato externo: ningún proveedor alternativo arregla
        // una credencial rechazada.
        opciones = [
            opcion(OPCION.renovar_credencial, vars,
                'Ningún proveedor alternativo arregla una credencial rechazada.'),
            opcion(OPCION.pasar_alternativo, vars, null),
            opcion(OPCION.esperar_servicio, vars, null),
        ];
    } else {
        let recoReintentar = null;
        let recoPasar = null;
        if (n.conexionRestablecida === true) {
            recoReintentar = n.ultimoIntentoEdad
                ? 'El proveedor ya contesta bien desde {edad}.'
                : 'El proveedor ya contesta bien.';
        } else if (n.conexionRestablecida === false && n.alternativoConCuota === true) {
            recoPasar = 'El proveedor sigue sin contestar y el alternativo tiene cuota.';
        } else {
            sinReco = 'No hay recomendación: no pude ver si el proveedor ya volvió a contestar.';
        }
        opciones = [
            opcion(OPCION.reintentar_ahora, vars, recoReintentar),
            opcion(OPCION.pasar_alternativo, vars, recoPasar),
            opcion(OPCION.esperar_servicio, vars, null),
        ];
    }

    // NUNCA el stack, la URL, el endpoint ni el cuerpo de la respuesta (UX §4.4):
    // la evidencia de infra son CONTADORES y ANTIGÜEDADES, no texto del error.
    const evidencia = [];
    if (cuantos && cuantos > 1) evidencia.push(`${cuantos} trabajos frenados por lo mismo`);
    if (n.primerFalloEdad && n.ultimoIntentoEdad) {
        evidencia.push(`Primer fallo: ${n.primerFalloEdad} · último intento: ${n.ultimoIntentoEdad}`);
    } else if (n.primerFalloEdad) {
        evidencia.push(`Primer fallo: ${n.primerFalloEdad}`);
    }

    return {
        por_que: INFRA_POR_QUE[cat],
        que_se_decide: interp(
            credencial ? COPY.infra.que_se_decide_credencial : COPY.infra.que_se_decide, vars,
        ),
        opciones,
        evidencia,
        costo: (cuantos && cuantos > 1)
            ? interp(COPY.infra.costo_varios, vars)
            : COPY.infra.costo_solo,
        sin_reco: sinReco,
        ejemplo: credencial ? 'renovar' : COPY.infra.ejemplo,
    };
}

function fichaRebote(n) {
    const vars = { issue: n.issue, ref: refIssue(n.issue), fase: n.rechazoFase };
    const observado = externo(n.reason || n.question, MAX_EVIDENCIA);

    // ★ Sin motivo legible no hay nada accionable que recomendar: "mandalo a
    // corregir con lo observado" es una recomendación vacía si no hay observado.
    const recoCorregir = observado ? 'Las observaciones son concretas y accionables.' : null;
    const sinReco = observado ? '' : COPY.rebote.sin_reco;

    const evidencia = [];
    if (observado) evidencia.push(`Lo observado: ${observado}`);
    if (n.rebotes) evidencia.push(`Es la vuelta ${n.rebotes} de ${n.rebotesMax}`);
    if (n.ultimoRechazoEdad) evidencia.push(`Devuelto ${n.ultimoRechazoEdad}`);
    else if (n.edad) evidencia.push(`Devuelto ${n.edad}`);

    return {
        por_que: n.rechazoFase
            ? interp(COPY.rebote.por_que, vars)
            : COPY.rebote.por_que_sin_fase,
        que_se_decide: interp(COPY.rebote.que_se_decide, vars),
        opciones: [
            opcion(OPCION.mandar_corregir, vars, recoCorregir),
            opcion(OPCION.aprobar_igual, vars, null),
            opcion(OPCION.replantear_alcance, vars, null),
        ],
        evidencia,
        costo: COPY.rebote.costo,
        sin_reco: sinReco,
        ejemplo: COPY.rebote.ejemplo,
    };
}

function fichaPregunta(n) {
    const vars = { issue: n.issue, ref: refIssue(n.issue) };
    const evidencia = [];
    // `rol` y `tarea` pueden colapsar en lo mismo (el `po` en fase `criterios`
    // es "la definición de producto" haciendo "la definición"): decirlo dos
    // veces suena a bug, así que en ese caso va sólo el rol.
    if (n.rol && n.tarea && n.rol !== n.tarea && !n.rol.includes(n.tarea)) {
        evidencia.push(`Lo preguntó ${n.rol} mientras hacía ${n.tarea}`);
    } else if (n.rol) {
        evidencia.push(`Lo preguntó ${n.rol}`);
    }
    if (n.edad) evidencia.push(`Frenado ${n.edad}`);

    // ★ NINGUNA recomendada, siempre. La pregunta es sobre el producto: el
    // pipeline no tiene con qué recomendar una respuesta de producto.
    return {
        por_que: COPY.pregunta.por_que,
        // UX §1.8 — LITERAL. Parafrasear la pregunta de un agente la cambia.
        que_se_decide: citado(n.question, MAX_PREGUNTA_LITERAL),
        opciones: [
            opcion(OPCION.responder_pregunta, vars, null),
            opcion(OPCION.pedir_contexto, vars, null),
            opcion(OPCION.replantear_por_pregunta, vars, null),
        ],
        evidencia,
        costo: COPY.pregunta.costo,
        sin_reco: COPY.pregunta.sin_reco,
        ejemplo: COPY.pregunta.ejemplo,
    };
}

/** Qué dato falta, según el caso. Nunca un genérico vacío. */
function faltaDe(n) {
    const txt = `${n.reason} ${n.question}`.trim();
    if (n.firmantesAutorizados === 0) return COPY.indeterminado.falta_sin_firmante;
    if (!txt) return COPY.indeterminado.falta_sin_motivo;
    if (RE_DEP.test(txt) && n.deps.length === 0) return COPY.indeterminado.falta_dep_sin_numero;
    if (n.reasonCategory === 'unknown') return COPY.indeterminado.falta_ilegible;
    if (n.question && !esPreguntaUsable(n)) return COPY.indeterminado.falta_ilegible;
    return COPY.indeterminado.falta_sin_motivo;
}

function fichaIndeterminado(n) {
    // Evidencia: SÓLO lo afirmable. Si no hay nada, lista vacía — vacía es
    // honesta, rellena es ruido (UX §1.5).
    const evidencia = [];
    if (n.edad) evidencia.push(`Frenado ${n.edad}`);
    if (n.rol) evidencia.push(`Último que lo tocó: ${n.rol}`);

    // `opciones` VACÍA SIEMPRE (CA-A5). Cero es mejor que tres inventadas: una
    // opción genérica que el operador no puede ejecutar es peor que decir "no sé".
    return {
        por_que: COPY.indeterminado.por_que,
        que_se_decide: interp(COPY.indeterminado.que_se_decide, { issue: n.issue, ref: refIssue(n.issue) }),
        opciones: [],
        evidencia,
        costo: COPY.indeterminado.costo,
        sin_reco: '',
        ejemplo: COPY.indeterminado.ejemplo,
    };
}

const CONSTRUCTOR = deepFreeze({
    dependencia: fichaDependencia,
    circuit: fichaCircuit,
    firma: fichaFirma,
    infra: fichaInfra,
    rebote: fichaRebote,
    pregunta: fichaPregunta,
    indeterminado: fichaIndeterminado,
});

// =============================================================================
// Copy del MENSAJE, no de la ficha.
//
// El encabezado del aviso agrupado, la línea de excedente, el encabezado del
// recordatorio y el aviso de fallback también son copy: si cada canal armara el
// suyo volveríamos exactamente al problema que este issue cierra (CA-1). El
// renderer decide el LAYOUT —qué va en qué línea, qué emoji, qué separador—;
// las palabras salen de acá.
// =============================================================================

/** Encabezado del aviso agrupado (UX §1.1). Sólo tiene sentido con más de uno. */
function encabezadoAgrupado(total) {
    const n = Number(total) || 0;
    return n === 1
        ? 'Un trabajo espera una decisión tuya'
        : `${n} trabajos esperan una decisión tuya`;
}

/**
 * Línea de excedente (UX §1.6). '' si no quedó nadie afuera: un "otros 0
 * trabajos" es ruido y erosiona la confianza en el resto del mensaje.
 *
 * Dice el número EXACTO —nunca "algunos"— para que el operador pueda cerrar la
 * cuenta `1 destacado + N compactas + k afuera = n del encabezado`, y dice
 * DÓNDE verlos, porque el tablero es la única superficie donde están todos.
 */
function lineaExcedente(k) {
    const n = Number(k) || 0;
    if (n <= 0) return '';
    if (n === 1) return 'Hay 1 trabajo más esperando decisión que no entró en este mensaje. Está en el tablero.';
    return `Otros ${n} trabajos esperan decisión y no entraron en este mensaje. Están todos en el tablero, ordenados por antigüedad.`;
}

/**
 * Encabezado del recordatorio (UX §2.2 / H-UX-8).
 *
 * Decir "recordatorio" cada vez, sin decir cuántas veces ya se avisó, entrena al
 * operador a ignorarlo: el número ES la información, y hoy vive escondido en un
 * paréntesis en cursiva. Por eso sube al encabezado.
 */
const ORDINAL_AVISO = deepFreeze(['', '', 'Segundo', 'Tercer']);
function encabezadoRecordatorio(nAviso, total) {
    const n = Number(total) || 0;
    const a = Number(nAviso);
    const rotulo = (Number.isInteger(a) && a >= 2)
        ? (ORDINAL_AVISO[a] ? `${ORDINAL_AVISO[a]} aviso` : `${a}º aviso`)
        : 'Recordatorio';
    const cuerpo = n === 1
        ? '1 trabajo sigue esperando tu decisión'
        : `${n} trabajos siguen esperando tu decisión`;
    return `${rotulo}: ${cuerpo}`;
}

/** Sufijo de la línea compacta con el número de aviso. '' si es el primero. */
function sufijoAviso(nAviso) {
    const a = Number(nAviso);
    return Number.isInteger(a) && a > 1 ? `${a}º aviso` : '';
}

/**
 * Cierre del recordatorio (UX §2.2). Es la única frase que no está en la ficha
 * y se gana el lugar: es la razón de existir del recordatorio.
 */
const CIERRE_RECORDATORIO = 'Nada se destraba solo por dejar pasar el tiempo.';

/**
 * Copy del aviso de FALLBACK (UX §3), el que sale cuando armar la ficha lanza.
 *
 * Son constantes, no funciones que dependan del resto del módulo: el fallback se
 * usa justo cuando algo de acá adentro falló, así que leer una tabla congelada
 * es todo lo que se puede permitir.
 *
 * Declara el fallo en vez de esconderlo (un aviso degradado sin explicación se
 * lee como un bug y se ignora), dice explícitamente que NADA se destrabó —el
 * peor desenlace es que el operador interprete el aviso raro como "ya está
 * resuelto"— y NO inventa opciones.
 */
const FALLBACK = deepFreeze({
    encabezado_uno: 'Hay 1 trabajo esperando tu decisión y no pude armar el detalle.',
    encabezado_varios: 'Hay {n} trabajos esperando tu decisión y no pude armar el detalle.',
    cierre: `No te muestro opciones porque no pude prepararlas. Siguen frenados: esto no destrabó nada. Mirá el tablero para decidir, o respondé /unblock {issue} ${ORIENTACION_LIBRE}.`,
    cierre_sin_numero: 'No te muestro opciones porque no pude prepararlas. Siguen frenados: esto no destrabó nada. Mirá el tablero para decidir.',
});

// =============================================================================
// API pública
// =============================================================================

/**
 * Construye la ficha de decisión de UN bloqueo.
 *
 * NO atrapa sus propios errores: el call-site es el que decide qué hacer si
 * esto lanza, y la política es fail-closed hacia la visibilidad (emitir el
 * aviso crudo REDACTADO y dejar el issue bloqueado). Un `catch {}` acá
 * convertiría un bug en un aviso silenciosamente incompleto.
 *
 * @param {object} raw    Forma de `listBlockedIssues()` + contexto opcional.
 * @param {number} nowMs  "Ahora" inyectado (CA-A6). Sin él, la antigüedad
 *                        degrada a `age_hours` en vez de leer el reloj real.
 * @returns {object} ficha congelada en profundidad.
 */
function buildDecisionCard(raw, nowMs) {
    const n = normalizar(raw, nowMs);
    const tipo = clasificar(n);
    const build = CONSTRUCTOR[tipo] || CONSTRUCTOR.indeterminado;
    const f = build(n);
    const indeterminado = tipo === 'indeterminado';

    // Los caps se aplican en la frontera, sobre TODOS los campos, sin excepción.
    const opciones = (f.opciones || []).map((o) => ({
        etiqueta: sec(o.etiqueta, 48),
        consecuencia: sec(o.consecuencia, MAX_CAMPO),
        es_recomendada: o.es_recomendada === true,
        razon_recomendacion: sec(o.razon_recomendacion, MAX_CAMPO),
    }));

    // CA-A4 — invariante duro: A LO SUMO UNA recomendada, y si la hay, con
    // `razon_recomendacion` no vacía. Se degrada en vez de lanzar: un aviso con
    // dos "recomendadas" confunde más que uno sin ninguna.
    let yaHay = false;
    for (const o of opciones) {
        if (!o.es_recomendada) continue;
        if (yaHay || !o.razon_recomendacion) {
            o.es_recomendada = false;
            o.razon_recomendacion = '';
        } else {
            yaHay = true;
        }
    }

    const hayReco = opciones.some((o) => o.es_recomendada);
    // Cuando no hay recomendada la ficha DICE POR QUÉ no la hay (CA-A4). Cero
    // recomendadas es válido y esperado en `firma` y `pregunta`; el silencio no.
    let sinRecoPorque = '';
    if (!hayReco && !indeterminado) {
        sinRecoPorque = sec(f.sin_reco || 'No hay recomendación: no tengo un dato verificable en el que apoyarla.', MAX_CAMPO);
    }

    const evidencia = (f.evidencia || [])
        .map((e) => sec(e, MAX_EVIDENCIA))
        .filter(Boolean)
        .slice(0, MAX_EVIDENCIAS);

    // NUNCA un default de molde acá: un `|| 'qué-hacer'` reintroduce el defecto
    // que este issue cierra por la puerta de atrás, para CUALQUIER tipo cuya
    // plantilla no declare valor. Vacío significa "lo escribe el operador".
    const ejemplo = sec(f.ejemplo, 40);
    const ref = refIssue(n.issue);

    // UX §5 — el título va SIEMPRE entre «comillas angulares», en una sola línea
    // y precedido de su número: un título que abre línea es exactamente lo que
    // necesita para disfrazarse de estructura del mensaje (R-3). Si queda vacío
    // después de sanear se dice "(sin título)", nunca un «» hueco, que se lee
    // como que el pipeline perdió el dato.
    let tituloFicha;
    if (n.titulo) tituloFicha = `${ref} «${n.titulo}»`;
    else if (n.issue) tituloFicha = `${ref} (sin título)`;
    else tituloFicha = 'Un trabajo del que no tengo el número';

    return deepFreeze({
        tipo,
        issue: n.issue,
        que_esta_frenado: {
            // R-3 — el título va ATRIBUIDO entre «comillas angulares», nunca
            // fusionado con lo que redacta el pipeline, para que se lea como
            // "esto lo escribió el issue" y no como una afirmación del sistema.
            titulo: tituloFicha,
            desde: n.edad,
        },
        por_que_esta_frenado: sec(f.por_que, MAX_CAMPO),
        que_se_decide: sec(f.que_se_decide, MAX_CAMPO),
        // Forma corta por tipo, para la línea compacta del mensaje agrupado
        // (UX §1.5). No es una versión propia del renderer: si no entrara y
        // cada canal la reescribiera ad hoc, volveríamos al problema que este
        // issue cierra.
        que_se_decide_corto: sec(CORTO[tipo] || CORTO.indeterminado, MAX_CAMPO),
        opciones,
        evidencia_minima: evidencia,
        costo_de_no_decidir: sec(f.costo, MAX_CAMPO),
        sugerencia_del_pipeline: n.sugerencia,
        sin_recomendacion_porque: sinRecoPorque,
        indeterminado,
        falta: indeterminado ? sec(faltaDe(n), MAX_CAMPO) : '',
        // H-UX-3 — el pie deja de ser un molde. `/unblock <issue> <orientación>`
        // con `<issue>` literal obliga al operador a ir a buscar el número
        // arriba, y con 3 fichas agrupadas ni siquiera sabe cuál poner.
        ejemplo_de_valor: ejemplo,
        // Sin número no hay comando que el operador pueda ejecutar: se lo manda
        // al tablero en vez de darle un molde que falla al pegarlo.
        // Con valor de ejemplo el pie se pega tal cual y funciona. Sin él, dice
        // con palabras que la orientación la escribe el operador (rev-1): un
        // valor inventado se pega igual y el agente lo lee como indicación.
        pie_destrabe: n.issue
            ? `Para decidir, respondé: /unblock ${n.issue} ${ejemplo || ORIENTACION_LIBRE}`
            : 'Para decidir, mirá el tablero: sin el número no puedo darte el comando.',
    });
}

/**
 * Fichas de una lista de bloqueos. Sin barrera ni estado compartido: cada ficha
 * es independiente de las demás.
 */
function buildDecisionCards(rawList, nowMs) {
    return (Array.isArray(rawList) ? rawList : []).map((r) => buildDecisionCard(r, nowMs));
}

module.exports = {
    TIPOS,
    // Primitivas de saneamiento compartidas con `decision-card-render.js`.
    // Se exportan como DATO (no como lógica) a propósito: el camino de
    // fallback del renderer tiene que poder sanear sin invocar al armador de
    // fichas —que es justo el que acaba de fallar—, pero tampoco puede tener
    // su propia copia de estas tablas. Una copia diverge; una constante
    // congelada compartida, no. Es la misma lección de `ORIENTACION_LIBRE`.
    CONTROL_RANGES,
    URL_RE,
    URL_MARCA,
    ORIENTACION_LIBRE,
    MOLDES_DE_ORIENTACION,
    esOrientacionMolde,
    MAX_CAMPO,
    MAX_EVIDENCIA,
    MAX_EVIDENCIAS,
    MAX_PREGUNTA_LITERAL,
    COPY,
    CORTO,
    OPCION,
    FALLBACK,
    CIERRE_RECORDATORIO,
    encabezadoAgrupado,
    lineaExcedente,
    encabezadoRecordatorio,
    sufijoAviso,
    refIssue,
    FASE_LEGIBLE,
    ROL_LEGIBLE,
    INFRA_POR_QUE,
    deepFreeze,
    edadDesdeMinutos,
    edadDesdeHoras,
    faseLegible,
    rolLegible,
    buildDecisionCard,
    buildDecisionCards,
};
