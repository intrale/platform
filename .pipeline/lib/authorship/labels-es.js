// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7633 — Diccionario ÚNICO del copy del export de autoría (U2 · U3 · CA-1).
//
// Módulo PURO, sin I/O. Los textos van SIN escapar: el escape vive en un solo
// punto, el renderer (`export-chain.js`). Si este módulo escapara, el texto
// saldría doble-escapado (`&amp;lt;`).
//
// Los motivos técnicos de "sin dirección humana" (`REASONS` de `trailer.js`) no
// se redactan otra vez: se toman de `copy.js` (#7631), que es la fuente que
// usan el comentario de dry-run y el bloqueo en `enforce`.
// =============================================================================

const { REASONS, DIRECTION_KINDS } = require('./trailer');
const { REASON_COPY } = require('./copy');

// Tipo de decisión que ancla el trailer → qué hizo la persona.
const DECISION_LABELS = Object.freeze({
    gate2: 'Firmó la aceptación del código',
    gate1: 'Firmó la definición de la tarea',
    approval: 'Aprobó por el canal de firma',
    none: 'Sin firma registrada',
});

// Rol del agente → qué hizo la IA.
const ROLE_LABELS = Object.freeze({
    'backend-dev': 'escribió el código',
    'pipeline-dev': 'escribió el código',
    'android-dev': 'escribió el código',
    'web-dev': 'escribió el código',
    review: 'revisó el código',
    tester: 'ejecutó las pruebas',
    qa: 'probó el funcionamiento',
    security: 'revisó la seguridad',
});

// Proveedor del trailer → nombre legible. Un proveedor desconocido se muestra
// tal cual (ya pasó la allowlist del trailer).
const PROVIDER_LABELS = Object.freeze({
    anthropic: 'Anthropic',
    claude: 'Anthropic',
    openai: 'OpenAI',
    codex: 'OpenAI',
    'openai-codex': 'OpenAI',
    google: 'Google',
    antigravity: 'Google Antigravity',
});

// Estado de cada cambio (U3). Siempre ícono + texto, nunca sólo color.
const STATE_LABELS = Object.freeze({
    signed: '✔ Dirección humana firmada',
    unsigned: '⚠ Sin firma registrada',
    invalid: '✖ Trailer inválido',
});

// "Quién dirigió" cuando no hay firma que mostrar.
const WHO_LABELS = Object.freeze({
    operatorSuffix: '(operador)',
    unsigned: 'Sin firma registrada',
    invalid: 'No se puede afirmar',
});

// Motivos propios del export (además de los `REASONS` del trailer).
//   dry-run      → commit posterior a la vigencia pero sin bloque de autoría.
//   pre-go-live  → commit anterior a `authorship.go_live_date`.
//   unrecognized → hay bloque, pero un valor no cumple el formato: NO se muestra.
const EXPORT_REASONS = Object.freeze(['dry-run', 'pre-go-live', 'unrecognized']);

const UNSIGNED_REASONS = Object.freeze({
    'dry-run': 'Se integró mientras la verificación estaba en modo de prueba.',
    'pre-go-live': 'Cambio anterior a la entrada en vigencia del registro de firma ({fecha}).',
    unrecognized: 'El dato de firma de este cambio no tiene un formato reconocido; por seguridad no se muestra.',
    ...REASON_COPY,
});

const INVALID_REASON = 'Los datos de autoría de este cambio están repetidos o fuera de lugar, así que no se toman como firma y el cambio no suma al conteo.';

const ZERO_OF_N_NOTE = 'Ningún cambio de este alcance tiene firma registrada. Es lo esperado mientras la verificación de firma funciona en modo de prueba; no indica un error del documento.';

// Leyenda obligatoria (CA-2 / SE): va visible en el PDF, aunque haya 0 firmados.
// `main` se muestra en monoespaciado, por eso viaja partida.
const LEGEND = Object.freeze({
    before: 'Esta constancia verifica la consistencia de los registros en ',
    code: 'main',
    after: '; no prueba por sí sola la autenticidad de la firma.',
});

/** Texto de un rol. Desconocido → `asistió (<rol>)`, SIN escapar. */
function roleLabel(role) {
    const r = String(role == null ? '' : role);
    return Object.prototype.hasOwnProperty.call(ROLE_LABELS, r) ? ROLE_LABELS[r] : `asistió (${r})`;
}

function providerLabel(provider) {
    const p = String(provider == null ? '' : provider);
    return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, p) ? PROVIDER_LABELS[p] : p;
}

function decisionLabel(kind) {
    return Object.prototype.hasOwnProperty.call(DECISION_LABELS, kind) ? DECISION_LABELS[kind] : DECISION_LABELS.none;
}

/**
 * Texto del "Por qué" de un cambio sin firma. Nunca devuelve vacío (U3): un
 * motivo desconocido cae en el de "dato no reconocido".
 *
 * @param {string} reason
 * @param {{goLiveDateText?: string}} [ctx] — fecha de vigencia ya formateada.
 */
function unsignedReasonText(reason, { goLiveDateText = '' } = {}) {
    const key = Object.prototype.hasOwnProperty.call(UNSIGNED_REASONS, reason) ? reason : 'unrecognized';
    return UNSIGNED_REASONS[key].replace('{fecha}', goLiveDateText || 'fecha no configurada');
}

module.exports = {
    DECISION_LABELS,
    ROLE_LABELS,
    PROVIDER_LABELS,
    STATE_LABELS,
    WHO_LABELS,
    EXPORT_REASONS,
    UNSIGNED_REASONS,
    INVALID_REASON,
    ZERO_OF_N_NOTE,
    LEGEND,
    REASONS,
    DIRECTION_KINDS,
    roleLabel,
    providerLabel,
    decisionLabel,
    unsignedReasonText,
};
