'use strict';

// =============================================================================
// desync-copy.js — Fuente única del copy del estado de sincronización
// allowlist↔ola (#4375, #5724 CA-4).
//
// POR QUÉ EXISTE ESTE MÓDULO
// --------------------------
// El pill del semáforo nació embebido en `views/dashboard/pipeline.js`, que
// sólo se renderiza desde el catch-all legacy de `dashboard.js`. Ninguna de las
// rutas del menú del dashboard V3 pasa por ahí, así que el operador nunca vio
// el estado: el dispatch estuvo ~10 h suspendido y la vista Inicio seguía
// diciendo "No hay agentes corriendo. Verificar pausa parcial, cola y
// blocked:dependencies" — las tres causas equivocadas.
//
// Para poder mostrar el MISMO estado en la vista Inicio sin escribir una
// tercera versión del copy (ya había dos: el módulo SSR y el renderer cliente
// del monolito), la decisión de texto/severidad/antigüedad vive acá y la
// consumen todos los renderers. Nadie inventa copy propio.
//
// CONTRATO
// --------
// Módulo PURO: sin filesystem, sin red, sin `require` de estado del pipeline.
// Sólo transforma el shape del slice `desyncStatusSlice` en decisiones de
// presentación. Es seguro requerirlo desde cualquier vista o desde el slice.
//
// El HTML NO se arma acá: cada superficie tiene su propio layout (pill del
// panel Pipeline vs banner full-width de Inicio). Lo compartido es QUÉ decir,
// no CÓMO dibujarlo.
// =============================================================================

// Estados nominales del semáforo. `cls` es la clase de severidad; el layout la
// mapea a sus propios tokens. Nunca sólo color: cada estado se distingue por
// icono + label + detalle (WCAG AA). Prohibido el falso verde — `desconocido`
// es gris, no ok.
const DSS_META = {
    sincronizado:          { icon: 'allowlist-check',   label: 'Sincronizado',          cls: 'dss-ok',      aria: 'sincronizado' },
    realineado_reductivo:  { icon: 'estado-retrying',   label: 'Realineado',            cls: 'dss-warn',    aria: 'realineado, divergencia autoresoluble' },
    divergencia_bloqueada: { icon: 'warn',              label: 'Divergencia bloqueada', cls: 'dss-danger',  aria: 'divergencia bloqueada, requiere intervención' },
    desconocido:           { icon: 'stage-not-entered', label: 'Sin datos',             cls: 'dss-unknown', aria: 'sin datos de sincronización' },
};

// #5724 CA-4 / UX-2 — Presentación del estado BLOQUEANTE. El pill genérico
// nombraba el síntoma interno ("Divergencia bloqueada"), no la consecuencia
// operativa: el dispatch está suspendido y no se lanza ningún agente. Un
// operador que lee "divergencia bloqueada" no deduce "hace 10 horas que no
// arranca nada". Además el bloqueo usa `pause-lock` (candado de pausa) y deja
// `warn` para la divergencia que todavía no frenó nada.
const DSS_META_BLOQUEADO = {
    icon: 'pause-lock',
    label: 'Dispatch suspendido',
    cls: 'dss-danger',
    aria: 'dispatch suspendido por divergencia entre la allowlist y la ola activa',
};

// Normalización defensiva del contrato del slice: ante campo ausente/corrupto
// degradamos a `desconocido` (riesgo del render de `undefined`).
function normalizeDesyncStatus(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const estado = Object.prototype.hasOwnProperty.call(DSS_META, d.estado) ? d.estado : 'desconocido';
    // Acepta el shape del slice (`detected_at`) y el ya normalizado
    // (`detectedAt`): el view normaliza en el call-site Y adentro del render,
    // así que la función tiene que ser idempotente o pierde la antigüedad.
    const rawDetected = typeof d.detected_at === 'string' ? d.detected_at : d.detectedAt;
    const detectedAt = (typeof rawDetected === 'string' && Number.isFinite(Date.parse(rawDetected)))
        ? rawDetected
        : null;
    return {
        estado,
        added: (Array.isArray(d.added) ? d.added : []).filter(Number.isInteger),
        removed: (Array.isArray(d.removed) ? d.removed : []).filter(Number.isInteger),
        count: Number.isInteger(d.count) ? d.count : 0,
        bloqueado: Boolean(d.bloqueado),
        detectedAt,
    };
}

// #5724 UX-3 — "hace 2 h 15 min". La duración es lo que distingue un hipo de un
// incidente; sin ella el pill de 10 horas se ve igual que el de 10 minutos.
function desyncAgeText(detectedAt, nowMs) {
    const ts = Date.parse(detectedAt);
    if (!Number.isFinite(ts)) return '';
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const min = Math.floor((now - ts) / 60000);
    if (!Number.isFinite(min) || min < 0) return '';
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h >= 24) {
        const dias = Math.floor(h / 24);
        const restoH = h % 24;
        return restoH > 0 ? `hace ${dias} d ${restoH} h` : `hace ${dias} d`;
    }
    return m > 0 ? `hace ${h} h ${m} min` : `hace ${h} h`;
}

// Texto de detalle por estado (sin JSON crudo ni paths — CA-8).
function desyncDetailText(d, nowMs) {
    switch (d.estado) {
        case 'sincronizado':
            return d.count > 0 ? `${d.count} issues alineados` : 'allowlist alineada con la ola';
        case 'realineado_reductivo':
            return 'divergencia autoresoluble por el Pulpo · no bloquea';
        case 'divergencia_bloqueada': {
            // UX-1: la causa concreta, no la jerga del archivo.
            const partes = [];
            if (d.removed.length > 0) {
                partes.push(`${d.removed.length} ${d.removed.length === 1 ? 'issue' : 'issues'} de la ola fuera de la allowlist`);
            }
            if (d.added.length > 0) {
                partes.push(`${d.added.length} ${d.added.length === 1 ? 'issue' : 'issues'} de la allowlist fuera de la ola`);
            }
            if (partes.length === 0) partes.push('la allowlist y la ola activa divergen');
            if (d.bloqueado) partes.push('no se lanza ningún agente');
            const edad = d.bloqueado ? desyncAgeText(d.detectedAt, nowMs) : '';
            if (edad) partes.push(edad);
            return partes.join(' · ');
        }
        default:
            return 'waves/partial-pause ausente o degradado';
    }
}

// Meta efectiva: el bloqueo real (flag puesto) manda sobre el estado nominal.
function desyncMeta(d) {
    if (d.estado === 'divergencia_bloqueada' && d.bloqueado) return DSS_META_BLOQUEADO;
    return DSS_META[d.estado] || DSS_META.desconocido;
}

// Tope de chips de issues. #5724 UX-4: el tope no es silencioso — un truncado
// sin indicador se lee como "esto es todo", y CA-4 pide mostrar la divergencia
// concreta.
const DSS_CHIPS_TOPE = 6;

// Chips como DATO (no HTML): `{ tipo:'add'|'rem', issue:<int> }` más un
// `{ tipo:'more', ocultos:<int> }` final si hubo truncado. Cada superficie los
// dibuja a su manera; los enteros ya vienen validados por normalize.
function desyncChips(d) {
    const chips = [];
    d.added.slice(0, DSS_CHIPS_TOPE).forEach((n) => chips.push({ tipo: 'add', issue: n }));
    d.removed.slice(0, DSS_CHIPS_TOPE).forEach((n) => chips.push({ tipo: 'rem', issue: n }));
    if (chips.length === 0) return [];
    const ocultos = Math.max(0, d.added.length - DSS_CHIPS_TOPE) + Math.max(0, d.removed.length - DSS_CHIPS_TOPE);
    if (ocultos > 0) chips.push({ tipo: 'more', ocultos });
    return chips;
}

// #5724 CA-4 — El empty-state de "AHORA · EN EJECUCIÓN" decía "Verificar pausa
// parcial, cola y blocked:dependencies": tres causas que NO eran la causa. Con
// el dispatch suspendido por desync el mensaje tiene que nombrar el bloqueo
// real; sin bloqueo vuelve al texto de siempre (que sí es correcto entonces).
const DESYNC_EMPTY_DEFAULT = 'No hay agentes corriendo. Verificar pausa parcial, cola y blocked:dependencies.';
function desyncEmptyStateText(d, nowMs) {
    if (!d || d.bloqueado !== true) return DESYNC_EMPTY_DEFAULT;
    const edad = desyncAgeText(d.detectedAt, nowMs);
    const sufijo = edad ? ` (${edad})` : '';
    return `Dispatch suspendido por divergencia allowlist↔ola${sufijo}: el Pulpo no lanza agentes hasta converger. No es la cola ni la pausa parcial.`;
}

// Qué tiene que hacer el operador. Un banner que sólo describe el problema deja
// al operador adivinando; el bloqueo se destraba desde la ventana Pipeline.
const DESYNC_ACCION_BLOQUEADO = 'Revisá la allowlist contra la ola activa en Pipeline y convergé (o esperá la autoresolución del Pulpo).';

// Presentación completa lista para render. `role`: un estado que frena el
// pipeline entero no puede esperar a que el lector de pantalla termine lo que
// estaba diciendo → `alert` (assertive) en vez de `status` (polite).
function buildDesyncPresentation(raw, nowMs) {
    const d = normalizeDesyncStatus(raw);
    const meta = desyncMeta(d);
    const detail = desyncDetailText(d, nowMs);
    return {
        estado: d.estado,
        bloqueado: d.bloqueado,
        icon: meta.icon,
        label: meta.label,
        cls: meta.cls,
        aria: meta.aria,
        ariaFull: 'Estado de sincronización allowlist↔ola: ' + meta.aria + '. ' + detail,
        detail,
        role: d.bloqueado ? 'alert' : 'status',
        edad: desyncAgeText(d.detectedAt, nowMs),
        chips: desyncChips(d),
        accion: d.bloqueado ? DESYNC_ACCION_BLOQUEADO : '',
        emptyState: desyncEmptyStateText(d, nowMs),
    };
}

// =============================================================================
// #6117 — Copy de las AUTO-REPARACIONES del despacho (CA-UX-1 · R6)
//
// Los dos avisos que #6117 borró nacieron como literales inline en `pulpo.js`.
// Ese es exactamente el modo de fallo que este módulo existe para evitar: copy
// que nace pegado a la lógica, se duplica por superficie y termina divergiendo.
// Todo el texto de auto-reparación vive acá; `pulpo.js` sólo lo consume.
//
// Además cierra el riesgo de "dos mensajes distintos del mismo evento" con
// #5890: con una sola fuente no puede haber dos redacciones.
//
// Reglas vinculantes que gobiernan este bloque (comentario de criterios UX):
//   R1 — nunca el número del issue del pipeline entre paréntesis. Es
//        trazabilidad de código, no información del operador, y se confunde con
//        los issues reparados que aparecen dos líneas más abajo.
//   R2 — primero la consecuencia operativa, después el detalle.
//   R3 — toda alerta cierra con `Qué hacer:` (instrucción de reanudación).
//   R4 — tipos con etiqueta humana, NUNCA la clave interna.
//   R5 — sin stack, paths absolutos, config ni tokens. La causa llega YA
//        sanitizada: este módulo es puro y no puede redactar secretos.
// =============================================================================

// R4 — mapa cerrado clave interna → etiqueta humana. El JSONL guarda
// `convergencia_aditiva`; ninguna superficie visible lo muestra (CA-UX-2).
const AUTO_REPAIR_LABELS = {
    convergencia_aditiva: 'convergencia con la ola activa',
    reparacion_aditiva_wave_add: 'reposición de una promoción tuya',
};

/** Etiqueta humana de un tipo. Un tipo desconocido degrada sin filtrar la clave. */
function autoRepairLabel(tipo) {
    return AUTO_REPAIR_LABELS[tipo] || 'reparación de la lista de trabajo';
}

/** Lista de issues como chips de texto: `#4821, #4830`. */
function autoRepairIssuesText(issues) {
    const list = (Array.isArray(issues) ? issues : []).filter(Number.isInteger);
    return list.map((n) => `#${n}`).join(', ');
}

/** Ventana en criollo: "la última hora", "los últimos 30 min", "las últimas 6 h". */
function autoRepairWindowText(windowMs) {
    const ms = Number(windowMs);
    if (!Number.isFinite(ms) || ms <= 0) return 'la última hora';
    const min = Math.round(ms / 60000);
    if (min < 60) return `los últimos ${min} min`;
    const h = Math.round(min / 60);
    if (h === 1) return 'la última hora';
    if (h < 24) return `las últimas ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'el último día' : `los últimos ${d} días`;
}

/**
 * M1 · La reparación NO se aplicó (`r.ok === false`). El despacho sigue frenado.
 *
 * @param {object} o
 * @param {number[]} [o.issues]      issues que quedaron afuera
 * @param {string} [o.causa]         causa corta, YA sanitizada por el caller (R5)
 * @param {boolean} [o.gateRejected] H8: el gate rechazó con criterio, no falló
 */
function autoRepairFailureText({ issues, causa, gateRejected } = {}) {
    const lineas = ['⚠️ No pude reponer issues a la lista de trabajo.'];
    const chips = autoRepairIssuesText(issues);
    if (chips) lineas.push(`Quedaron afuera: ${chips}.`);
    // H8 — un `gate_rejected` no es un fallo técnico sino un rechazo con
    // criterio. El copy no los confunde porque lo que hay que hacer difiere.
    const motivo = gateRejected === true
        ? 'el gate de pausa parcial rechazó el cambio'
        : (causa || 'sin detalle');
    lineas.push(`Motivo: ${motivo}.`);
    lineas.push('Mientras tanto no se lanza ningún agente.');   // R2: consecuencia
    lineas.push('Qué hacer: abrí Pipeline, compará la ola activa con la lista y volvé a promover con /wave add.');
    return lineas.join('\n');
}

/** M2 · Excepción al aplicar la reparación. No se expone el error (R5). */
function autoRepairExceptionText() {
    return [
        '⚠️ No pude reponer issues a la lista de trabajo.',
        'Motivo: error inesperado al aplicar la reparación.',
        'Mientras tanto no se lanza ningún agente.',
        'Qué hacer: abrí Pipeline y revisá el log del Pulpo.',
    ].join('\n');
}

/**
 * M3 · Se reparó bien pero el audit no se pudo escribir (SEC-2).
 * No frena nada: lo que falta es la traza de quién habilitó qué.
 */
function autoRepairAuditFailedText({ issues } = {}) {
    const lineas = ['⚠️ Repuse issues pero no pude dejar registro de la operación.'];
    const chips = autoRepairIssuesText(issues);
    if (chips) lineas.push(`Repuestos: ${chips}.`);
    lineas.push('Ya están habilitados; lo que falta es la traza de auditoría.');
    lineas.push('Qué hacer: revisá el estado en Pipeline antes de seguir.');
    return lineas.join('\n');
}

/**
 * M4 · La misma reparación se repite: hay una causa de fondo.
 *
 * @param {object} o
 * @param {string} o.tipo
 * @param {number} o.count       cuántas veces en la ventana
 * @param {number} o.windowMs    ventana evaluada
 * @param {boolean} [o.ilegible] SEC-4: no se pudo contar, se avisa igual
 */
function autoRepairRepetitionText({ tipo, count, windowMs, ilegible } = {}) {
    const ventana = autoRepairWindowText(windowMs);
    const etiqueta = autoRepairLabel(tipo);
    const segunda = ilegible === true
        // Fail-open: se avisa sin poder afirmar el conteo, y se dice por qué.
        ? `No pude contar cuántas fueron en ${ventana} — el registro quedó ilegible — pero es ${etiqueta}.`
        : `Van ${count} reparaciones en ${ventana} — ${etiqueta}.`;
    return [
        '🔁 Vengo reponiendo lo mismo una y otra vez.',
        segunda,
        'Cada una salió bien, pero que se repita significa que algo las está desalineando de nuevo.',
        'Qué hacer: mirá Pipeline — hay una causa de fondo para atacar.',
    ].join('\n');
}

/**
 * CA-UX-5 · Presentación de la línea del dashboard (P1–P6), como DATO.
 * El HTML lo arma la vista; acá se decide QUÉ dice.
 *
 * @param {object|null} ultima  `{tipo, issues, timestamp}` del slice
 * @param {object} [opts]       { nowMs, repeticion: {count, ventana_ms, superado} }
 * @returns {{vacio: boolean, texto: string, label: string, chips: object[],
 *           edad: string, severidad: 'meta'|'warn', aviso: string}}
 */
function autoRepairLineaDashboard(ultima, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

    // P5 — empty-state EXPLÍCITO. La línea nunca se oculta: una línea que
    // aparece y desaparece hace dudar de la lectura.
    if (!ultima || !ultima.timestamp) {
        return {
            vacio: true,
            texto: 'Sin auto-reparaciones registradas.',
            label: '', chips: [], edad: '', severidad: 'meta', aviso: '',
        };
    }

    const label = autoRepairLabel(ultima.tipo);                 // P2 — R4
    const edad = desyncAgeText(ultima.timestamp, nowMs);        // P3 — reuso, no reimplementación

    // P4 — tope de chips reusando DSS_CHIPS_TOPE + `+N`. Un truncado silencioso
    // se lee como "esto es todo".
    const todos = (Array.isArray(ultima.issues) ? ultima.issues : []).filter(Number.isInteger);
    const chips = todos.slice(0, DSS_CHIPS_TOPE).map((n) => ({ tipo: 'issue', issue: n }));
    if (todos.length > DSS_CHIPS_TOPE) {
        chips.push({ tipo: 'more', ocultos: todos.length - DSS_CHIPS_TOPE });
    }

    // P6 — único caso que sube de jerarquía visual. Nunca sólo color: warning +
    // glyph + texto explícito.
    const rep = opts.repeticion;
    const superado = !!(rep && rep.superado === true);
    const aviso = superado
        ? `se repitió ${rep.count} veces en ${autoRepairWindowText(rep.ventana_ms)}`
        : '';

    const partes = ['Última auto-reparación', label];
    const chipsTexto = chips.map((c) => (c.tipo === 'more' ? `+${c.ocultos}` : `#${c.issue}`)).join(' ');
    if (chipsTexto) partes.push(chipsTexto);
    if (edad) partes.push(edad);
    if (aviso) partes.push(aviso);

    return {
        vacio: false,
        texto: partes.join(' · '),
        label,
        chips,
        edad,
        severidad: superado ? 'warn' : 'meta',   // P1: metadato, no alerta
        aviso,
    };
}

module.exports = {
    DSS_META,
    DSS_META_BLOQUEADO,
    DSS_CHIPS_TOPE,
    // #6117 — copy de auto-reparación (CA-UX-1..3, CA-UX-5).
    AUTO_REPAIR_LABELS,
    autoRepairLabel,
    autoRepairWindowText,
    autoRepairFailureText,
    autoRepairExceptionText,
    autoRepairAuditFailedText,
    autoRepairRepetitionText,
    autoRepairLineaDashboard,
    DESYNC_EMPTY_DEFAULT,
    DESYNC_ACCION_BLOQUEADO,
    normalizeDesyncStatus,
    desyncAgeText,
    desyncDetailText,
    desyncMeta,
    desyncChips,
    desyncEmptyStateText,
    buildDesyncPresentation,
};
