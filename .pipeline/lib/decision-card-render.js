'use strict';

// =============================================================================
// decision-card-render.js — Dibujo en TEXTO PLANO de la ficha de decisión
// (#6190, split de #6173).
//
// POR QUÉ ES UN MÓDULO APARTE
// ---------------------------
// Lo consumen dos canales: el aviso inicial (`human-block.js`) y el
// recordatorio (`human-block-reminder.js`). Los dos tienen que dibujar
// EXACTAMENTE el mismo dialecto — si cada uno armara el suyo volveríamos al
// problema que #6190 cierra: dos versiones del mismo texto que divergen sin que
// nadie se entere.
//
// Vivir acá y no dentro de `human-block.js` no es prolijidad: el recordatorio
// tiene una garantía ESTRUCTURAL de que no puede auto-aprobar un bloqueo por
// vencimiento de plazo, y esa garantía se sostiene en que no importa
// `human-block.js` —el módulo que sí sabe destrabar (`unblockIssue`,
// `dismissBlockedIssue`)—. Hacerlo importar para reusar el renderer habría roto
// la garantía en silencio; el test estructural de `human-block-notificacion`
// lo detecta. Ver `docs/pipeline/gates-firma-operador.md`.
//
// CONTRATO
// --------
// El copy NO se decide acá: sale entero de `lib/decision-card.js`, que es la
// fuente única (CA-1). Este módulo sólo decide el LAYOUT —qué va en qué línea,
// qué separador, qué entra en el presupuesto— y no inventa una sola palabra.
//
// Sin filesystem y sin estado del pipeline. La única dependencia con efecto es
// `redactAll`, en el camino de fallback.
// =============================================================================

const decisionCard = require('./decision-card');
const telegramTextBudget = require('./telegram-text-budget');
const { redactAll } = require('./sherlock-audit-jsonl');

/**
 * R-1 — Presupuesto del mensaje agrupado. EL HUECO DE DISEÑO REAL DEL ISSUE.
 *
 * Los CA fijan caps POR CAMPO (220 / evidencia 120 / audio 600) pero ninguno
 * por MENSAJE, y en paralelo exigen "un único mensaje agrupado con N issues".
 * Con el formato viejo cada issue ocupaba ~200 chars; con ficha son ~900-1500.
 * Con 3-4 bloqueos el mensaje cruza `TELEGRAM_TEXT_LIMIT` (4000) y quien arbitra
 * es `safeTruncate` en el transporte, truncando EN SILENCIO las fichas del
 * final — exactamente la falla que este issue viene a corregir. El propio
 * código del transporte lo declara: "Es una RED, no la solución […] Llegar acá
 * sigue significando pérdida silenciosa de contenido".
 *
 * Criterio implementado (hay que declararlo porque los CA no lo fijan):
 *   1. Ficha COMPLETA para todas las que entren, empezando por el `highlight`.
 *   2. Las que no entran degradan a UNA LÍNEA (la pregunta + cómo destrabar).
 *   3. Si ni así entra, se cortan fichas ENTERAS —nunca a la mitad— y el
 *      mensaje DECLARA cuántas quedaron afuera.
 * Se mide el render REAL en cada escalón, no se estima.
 *
 * El presupuesto es `HANDLER_TEXT_BUDGET` (3500), no `TELEGRAM_TEXT_LIMIT`
 * (4000): deja el margen que el transporte puede PREPENDER fuera de nuestro
 * control (el eco de transcripción cuando el comando llega por audio). Un
 * render que entra justo en 4000 se pasa cuando el mismo comando viene hablado.
 */
const FICHA_BUDGET = telegramTextBudget.HANDLER_TEXT_BUDGET;

/**
 * Una ficha completa, en el orden del contrato de copy (§6).
 *
 * `nivel` es la DEGRADACIÓN del §1.7, para el caso patológico en el que ni el
 * destacado entra en el presupuesto. Se degrada por lo más prescindible
 * primero: la evidencia es contexto, las opciones son la decisión.
 *   0 · completa
 *   1 · evidencia recortada a 1 ítem
 *   2 · además, sólo 2 opciones (la recomendada nunca se cae) y se declara que
 *       hay más en el tablero
 * Nunca se emite una ficha mutilada sin decirlo.
 */
function renderFichaCompleta(card, indice, total, nivel = 0) {
    const l = [];
    const prefijo = total > 1 ? `${indice} · ` : '';
    l.push(`${prefijo}${card.que_se_decide}`);

    const desde = card.que_esta_frenado.desde;
    l.push(`Qué está frenado: ${card.que_esta_frenado.titulo}${desde ? ` — ${desde}` : ''}.`);
    l.push(`Por qué: ${card.por_que_esta_frenado}`);

    if (card.indeterminado) {
        // Cero opciones inventadas (CA-A5): se dice qué falta y por qué no hay
        // propuesta. Tres opciones genéricas que el operador no puede ejecutar
        // son peores que ninguna.
        if (card.falta) l.push(`Qué me falta: ${card.falta}`);
        l.push('No te propongo opciones porque no las puedo justificar.');
    } else if (card.opciones.length) {
        // La recomendada NUNCA se recorta: es la única que trae razón, y una
        // ficha degradada que se queda sin la opción que el pipeline sugiere
        // pierde justo lo que el operador vino a buscar.
        let opciones = card.opciones;
        let recortadas = 0;
        if (nivel >= 2 && opciones.length > 2) {
            const reco = opciones.filter((o) => o.es_recomendada);
            const resto = opciones.filter((o) => !o.es_recomendada);
            const dejar = Math.max(0, 2 - reco.length);
            recortadas = resto.length - dejar;
            opciones = reco.concat(resto.slice(0, dejar));
        }
        l.push('Opciones:');
        opciones.forEach((o, k) => {
            l.push(` ${k + 1}. ${o.etiqueta}${o.es_recomendada ? '  ← recomendada' : ''}`);
            if (o.consecuencia) l.push(`    Qué pasa: ${o.consecuencia}`);
            if (o.es_recomendada && o.razon_recomendacion) {
                l.push(`    Por qué la recomiendo: ${o.razon_recomendacion}`);
            }
        });
        if (recortadas > 0) l.push('Hay más opciones en el tablero.');
        // CA-A4 — cero recomendadas es válido (y esperado en `firma` y
        // `pregunta`), pero el silencio no: la ficha dice POR QUÉ no la hay.
        if (card.sin_recomendacion_porque) l.push(card.sin_recomendacion_porque);
    }

    if (card.sugerencia_del_pipeline) {
        l.push(`Sugerencia del pipeline: ${card.sugerencia_del_pipeline}`);
    }
    const evidencia = nivel >= 1 ? card.evidencia_minima.slice(0, 1) : card.evidencia_minima;
    if (evidencia.length) l.push(`Para saber más: ${evidencia.join(' · ')}`);
    if (card.costo_de_no_decidir) l.push(`Si no decidís: ${card.costo_de_no_decidir}`);
    // H-UX-3 — número real y valor de ejemplo, no un molde con `<issue>`.
    l.push(card.pie_destrabe);
    return l.join('\n');
}

/** Tope de la línea compacta (UX §1.4). */
const COMPACTA_MAX = 200;

/**
 * Una línea por trabajo, para todos los que no son el destacado (UX §1.4).
 *
 * Si no entra en `COMPACTA_MAX` se recorta EL TÍTULO —nunca la pregunta ni el
 * comando— con la elipsis DENTRO de las comillas angulares: afuera se lee como
 * si el título terminara ahí. Recortar la pregunta deja una compacta que no
 * dice qué se decide, que es el defecto exacto que este issue viene a cerrar.
 *
 * La compacta NO lleva opciones, consecuencia, evidencia ni costo: una compacta
 * con media opción es peor que una sin ninguna, porque sugiere que ésa es la
 * única.
 *
 * Cada compacta lleva SU PROPIO comando con el número real (H-UX-3): con N
 * trabajos en un mensaje, un pie único es ambiguo.
 */
function renderFichaCompacta(card, indice, total, avisoN) {
    const prefijo = total > 1 ? `${indice} · ` : '';
    const aviso = decisionCard.sufijoAviso(avisoN);
    const edad = [card.que_esta_frenado.desde, aviso].filter(Boolean).join(', ');
    // El separador es UN carácter, no markup: `->` son dos y se lee como código.
    // El valor de ejemplo puede venir vacío a propósito (`pregunta`,
    // `indeterminado`): ahí la cola dice con palabras que la orientación la
    // escribe el operador, en vez de un molde pegable que el agente leería como
    // indicación humana real (#6190, rev-1).
    const cola = card.issue
        ? ` → /unblock ${card.issue} ${card.ejemplo_de_valor || decisionCard.ORIENTACION_LIBRE}`
        : '';
    const armar = (titulo) => `${prefijo}${titulo}${edad ? ` — ${edad}` : ''}. ${card.que_se_decide_corto}${cola}`;

    const linea = armar(card.que_esta_frenado.titulo);
    if (linea.length <= COMPACTA_MAX) return linea;

    // Se recorta adentro de «…». Si el título no viene entre comillas (caso
    // "(sin título)") no hay nada que recortar y la línea sale como está: es
    // preferible una línea larga a una sin pregunta ni comando.
    const m = card.que_esta_frenado.titulo.match(/^(.*?)«(.*)»$/);
    if (!m) return linea;
    const disponible = m[2].length - (linea.length - COMPACTA_MAX) - 1;
    if (disponible < 8) return armar(`${m[1].trim()} (título largo)`);
    const cortado = m[2].slice(0, disponible).replace(/[\s,;:.]+$/, '');
    return armar(`${m[1]}«${cortado}…»`);
}

/**
 * Arma el texto con UNA ficha completa (el destacado) y `nCompactas` en una
 * línea, declarando cuántas quedaron afuera.
 *
 * UX §1.2, regla que no se negocia: NUNCA hay dos fichas completas. Dos fichas
 * completas es la forma más rápida de volver a cruzar el presupuesto sin darse
 * cuenta, y el presupuesto es justamente el agujero que este issue tapa.
 *
 * El separador entre bloques es una línea en blanco, no una regla de guiones:
 * en texto plano los guiones largos se leen como ruido en el cliente móvil.
 */
function armarMensajeFichas(cards, nCompletas, nCompactas, opts = {}) {
    const total = cards.length;
    const ocultas = Math.max(0, total - nCompletas - nCompactas);
    const avisos = opts.avisos || {};
    const bloques = [];

    // Encabezado sólo si hay más de una: con una sola ficha es ruido. El
    // recordatorio lo apaga porque ya trae el suyo, y dos encabezados seguidos
    // se leen como un mensaje duplicado.
    if (total > 1 && opts.encabezado !== false) {
        bloques.push(`🚦 ${decisionCard.encabezadoAgrupado(total)}`);
    }

    for (let k = 0; k < nCompletas; k++) {
        bloques.push(renderFichaCompleta(cards[k], k + 1, total, opts.nivel || 0));
    }
    for (let k = nCompletas; k < nCompletas + nCompactas; k++) {
        bloques.push(renderFichaCompacta(cards[k], k + 1, total, avisos[cards[k].issue]));
    }
    const excedente = decisionCard.lineaExcedente(ocultas);
    if (excedente) bloques.push(excedente);
    return bloques.join('\n\n');
}

/**
 * Elige la vista más informativa que entra en el presupuesto, midiendo el
 * render REAL en cada escalón (nunca estimando).
 *
 * Devuelve `{ text, completas, compactas, ocultas }`. La cuenta SIEMPRE cierra:
 * `completas + compactas + ocultas === cards.length`. Es lo que le permite al
 * operador verificar que no desapareció nadie (UX §7.4) sin confiar en el test.
 */
function fitFichas(cards, budget = FICHA_BUDGET, opts = {}) {
    const total = cards.length;
    const cap = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : FICHA_BUDGET;
    const armar = (comp, nivel) => armarMensajeFichas(cards, 1, comp, Object.assign({}, opts, { nivel }));

    // 1. Destacado completo + todas las demás en una línea. Es la forma que fija
    //    UX §1.1 y la que entra con holgura en el caso normal.
    const completo = armar(total - 1, 0);
    if (completo.length <= cap) return { text: completo, completas: 1, compactas: total - 1, ocultas: 0 };

    // 2. Se cortan compactas ENTERAS —nunca a la mitad— y se declara cuántas.
    //    Búsqueda binaria sobre el largo real del render.
    let lo = 0;
    let hi = total - 1;
    let best = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const t = armar(mid, 0);
        if (t.length <= cap) { best = { text: t, compactas: mid }; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (best) {
        return { text: best.text, completas: 1, compactas: best.compactas, ocultas: total - 1 - best.compactas };
    }

    // 3. Caso patológico (§1.7): ni el destacado solo entra. Se degrada por lo
    //    más prescindible primero —evidencia, después opciones no recomendadas—
    //    y la ficha declara que hay más en el tablero.
    for (const nivel of [1, 2]) {
        const t = armar(0, nivel);
        if (t.length <= cap) return { text: t, completas: 1, compactas: 0, ocultas: total - 1 };
    }

    // 4. El destacado PASA A COMPACTA y el mensaje es todo compactas. Nunca se
    //    emite una ficha mutilada: antes se degrada la forma entera.
    lo = 1; hi = total; best = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const t = armarMensajeFichas(cards, 0, mid, opts);
        if (t.length <= cap) { best = { text: t, compactas: mid }; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (best) {
        return { text: best.text, completas: 0, compactas: best.compactas, ocultas: total - best.compactas };
    }

    // 5. Último recurso: ni una línea entra. Se avisa igual — la visibilidad no
    //    se degrada nunca, sólo el detalle.
    return {
        text: `🚦 ${decisionCard.encabezadoAgrupado(total)}. No entran en un mensaje: están todos en el tablero.`,
        completas: 0, compactas: 0, ocultas: total,
    };
}

/**
 * Render compartido de una lista de fichas ya construidas, en texto plano.
 *
 * Existe para que el recordatorio (`human-block-reminder.js`) dibuje EXACTAMENTE
 * el mismo dialecto que el aviso inicial. Si cada canal armara el suyo,
 * volveríamos al problema que este issue viene a cerrar: dos versiones del mismo
 * copy que divergen sin que nadie se entere.
 *
 * @param {Array}  cards    Salida de `buildDecisionCards`, YA ORDENADA: la
 *                          primera es el destacado y lleva la ficha completa.
 * @param {number} [budget] Presupuesto de chars del bloque de fichas.
 * @param {object} [opts]   `{ encabezado:false }` para omitir el `🚦`;
 *                          `{ avisos:{ [issue]: n } }` para el número de aviso.
 */
function renderDecisionCardsPlain(cards, budget = FICHA_BUDGET, opts = {}) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return '';
    return fitFichas(list, budget, opts).text;
}

/**
 * Antigüedad en minutos de un `raw`, sólo para ORDENAR. No se renderiza: el
 * texto de antigüedad lo redacta `decision-card` con su tabla (UX §5).
 */
function edadMinutosRaw(raw, nowMs) {
    const ts = Date.parse(raw && raw.blocked_at);
    if (Number.isFinite(ts) && Number.isFinite(nowMs)) return Math.max(0, (nowMs - ts) / 60000);
    const h = Number(raw && raw.age_hours);
    return Number.isFinite(h) && h >= 0 ? h * 60 : 0;
}

/**
 * Aviso de FALLBACK (UX §3). Se emite cuando armar las fichas lanza.
 *
 * NO depende de `decision-card` para sanear: es el módulo que acaba de fallar.
 * Redacta con `redactAll` y neutraliza markup y saltos de línea acá mismo, con
 * lo mínimo indispensable, para que este camino no pueda caerse por lo mismo.
 *
 * Muestra SÓLO título + antigüedad: son los dos campos que no dependen del
 * módulo que falló. Volcar el `reason` crudo "porque total es el fallback" es
 * la forma exacta en que este camino filtra — y es justo cuando el motivo tiene
 * más chances de traer un stack o un volcado de config (SEC-1).
 */
// Rangos de control, marcas invisibles y separadores de línea Unicode. La
// TABLA no se declara acá: se importa de `decision-card`, que es su única
// fuente. rev-2 / SEC-B: había una copia local y quedó corta (le faltaban los
// anuladores de dirección U+202A-U+202E y U+2066-U+2069) mientras la del
// armador se corregía — o sea, el mismo título salía saneado por una
// superficie y crudo por la otra. Importar una constante CONGELADA no rompe la
// independencia del fallback: no ejecuta nada del armador de fichas, y si el
// require de `decision-card` fallara este módulo no existiría (ya lo importa
// para el copy). Se arma el regex una sola vez, en carga.
const CONTROL_MINIMO_RE = new RegExp(
    '[' + decisionCard.CONTROL_RANGES
        .map(([x, y]) => String.fromCharCode(x) + '-' + String.fromCharCode(y)).join('') + ']',
    'g',
);

function sanearMinimo(v, max) {
    let s = String(v == null ? '' : v);
    if (!s) return '';
    // MISMO ORDEN que `sec()` en `decision-card`: controles → secretos → URLs →
    // markup. El orden importa (redactar antes de truncar; sacar controles
    // antes de buscar URLs, para que un carácter invisible metido en el medio
    // no parta el match) y tenerlo igual en ambos lados es lo que evita que
    // esta superficie vuelva a quedarse atrás.
    //
    // Saltos y controles a espacio: sin esto un título hostil fabrica líneas
    // falsas que imitan la estructura del mensaje.
    s = s.replace(CONTROL_MINIMO_RE, ' ');
    s = String(redactAll(s));
    // rev-2 / SEC-A: en TEXTO PLANO Telegram auto-enlaza las URLs desnudas.
    // Sin esto, el aviso degradado le entregaba al operador un link CLICKEABLE
    // escrito por un tercero (el repo es público, el título lo escribe
    // cualquiera) dentro de un mensaje que él lee como propio del pipeline —
    // y este es justo el camino que corre cuando la entrada es rara, o sea
    // cuando hay atacante. Se consume el regex del armador, no se copia.
    s = s.replace(decisionCard.URL_RE, decisionCard.URL_MARCA);
    s = s.replace(/\]\(/g, '] (').replace(/[*`<>]/g, '').replace(/_/g, ' ');
    // rev-7 / SEC-B: las «comillas angulares» son la frontera de atribución que
    // este mismo renderer agrega abajo. Si el título trae un `»` propio, cierra
    // la cita antes de tiempo y forja una entrada falsa con un `/unblock` sobre
    // un issue que nadie bloqueó. Se consume el regex del armador, no se copia.
    s = s.replace(decisionCard.GUILLEMET_RE, decisionCard.GUILLEMET_REEMPLAZO);
    // Y el `/comando` tappable que Telegram linkifica solo. Mismo motivo que
    // arriba: el camino degradado es JUSTO el que corre cuando la entrada es
    // rara, o sea cuando hay atacante. No puede ser el más flojo.
    s = s.replace(decisionCard.COMANDO_RE, decisionCard.COMANDO_REEMPLAZO);
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function renderFallbackAviso(raws, nowMs) {
    const total = raws.length;
    const enc = total === 1
        ? decisionCard.FALLBACK.encabezado_uno
        : String(decisionCard.FALLBACK.encabezado_varios).replace('{n}', String(total));

    const lineas = raws.map((r, i) => {
        const issue = Number(r && r.issue);
        const num = Number.isInteger(issue) && issue > 0 ? `#${issue}` : 'Un trabajo sin número';
        const titulo = sanearMinimo(r && (r.titulo || r.title), 120);
        const edad = decisionCard.edadDesdeMinutos(edadMinutosRaw(r, nowMs));
        const prefijo = total > 1 ? `${i + 1} · ` : '';
        return `${prefijo}${num}${titulo ? ` «${titulo}»` : ''}${edad ? ` — ${edad}` : ''}.`;
    });

    const primero = Number(raws[0] && raws[0].issue);
    const cierre = (Number.isInteger(primero) && primero > 0)
        ? String(decisionCard.FALLBACK.cierre).replace('{issue}', String(primero))
        : decisionCard.FALLBACK.cierre_sin_numero;

    return [`⚠️ ${enc}`, '', lineas.join('\n'), '', cierre].join('\n');
}

module.exports = {
    FICHA_BUDGET,
    COMPACTA_MAX,
    renderFichaCompleta,
    renderFichaCompacta,
    armarMensajeFichas,
    fitFichas,
    renderDecisionCardsPlain,
    renderFallbackAviso,
    edadMinutosRaw,
};
