// =============================================================================
// dispatch-watchdog-emisores.test.js — Una sola cadena de avisos (#5400 rev-1).
//
// B5 de la review: el mismo hecho ("hace N que no despacho") tenía DOS emisores
// con estado y cooldown independientes y sin dedup entre sí — `dispatch-cause`
// y `wave-stall-watchdog` — ambos a 45 min con cooldown de 30 y compartiendo el
// mismo instante de inicio. El operador recibía el par, repetido cada media
// hora, contra "avisar UNA vez" (CA-4).
//
// B6: el emisor hermano seguía mandando Markdown crudo. El texto interpola el
// detalle de la causa, que pasa por la redacción de secretos y queda con
// `[REDACTED:high-entropy]` y `snake_case` adentro: `[` sin link y `_` impar dan
// `400 can't parse entities`, el servicio reintenta con el MISMO parse_mode y la
// alerta termina en `fallido/`. O sea, el aviso de "el pipeline está parado" se
// auto-anula justo en el camino que este issue vuelve alertable.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dc = require('../dispatch-cause');
const wd = require('../wave-stall-watchdog');

const MIN = 60 * 1000;
const PULPO = path.join(__dirname, '..', '..', 'pulpo.js');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'emisores-'));
}

// ─── B5 · el mismo episodio produce UN aviso, no dos ────────────────────────

test('B5: ante la misma causa silenciosa sostenida sólo emite el watchdog', () => {
    const dir = tmpDir();
    try {
        const avisosDispatchCause = [];
        const snapshot = {
            anyLaunched: false,
            hayPendientes: true,
            progressInFlight: false,
            gatesActivos: new Set([dc.CAUSAS.SIN_AGENTES]),
            detalles: { [dc.CAUSAS.SIN_AGENTES]: 'todos los slots ocupados' },
        };
        const inicio = 1_000_000;

        // Ambos emisores ven el MISMO episodio, tick a tick, durante 3 h.
        let estadoWd = { lastMovementTs: inicio, lastStampTs: inicio, lastSignature: null, lastAlertTs: 0, alertCount: 0 };
        const avisosWatchdog = [];
        for (let min = 0; min <= 180; min += 5) {
            const now = inicio + min * MIN;
            dc.publish({
                pipelineDir: dir,
                snapshot,
                now,
                elegiblesEsperando: 5,
                alert: (m) => avisosDispatchCause.push(m),
            });
            const d = wd.decide({
                now,
                waveKey: 7,
                enabledCount: 5,
                dispatching: 0,
                cause: { declared: true, kind: 'concurrency-limit', readable: true },
                lastDispatchTs: inicio,
                state: estadoWd,
                stallMinutes: 20,
                cooldownMinutes: 30,
                declaredCauseEscalateMinutes: 45,
            });
            estadoWd = d.nextState;
            if (d.action !== 'skip') avisosWatchdog.push(d.message);
        }

        assert.equal(avisosDispatchCause.length, 0,
            'dispatch-cause no puede abrir una segunda cadena por el mismo hecho');
        assert.ok(avisosWatchdog.length > 0, 'el watchdog sí tiene que avisar');
        // Con cooldown de 30 min sobre 3 h de episodio: ~5 avisos, no 36 (uno por
        // tick) ni el doble por tener dos emisores.
        assert.ok(avisosWatchdog.length <= 6, `backoff verificable: ${avisosWatchdog.length} avisos en 3 h`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B5: el realce del banner sigue vivo aunque el aviso lo emita el otro módulo', () => {
    // No se perdió información: el dashboard sigue pintando la causa como grave.
    const dir = tmpDir();
    try {
        const comun = {
            pipelineDir: dir,
            snapshot: {
                anyLaunched: false, hayPendientes: true, progressInFlight: false,
                gatesActivos: new Set([dc.CAUSAS.MODO_OLA]), detalles: {},
            },
            elegiblesEsperando: 3,
        };
        dc.publish({ ...comun, now: 1000 });
        const out = dc.publish({ ...comun, now: 1000 + 60 * MIN });
        assert.equal(out.escaladoPorDuracion, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── B2 (rev-5) · la alerta tiene que SER ENTREGABLE, no "parecer plana" ────
//
// El test anterior era un regex sobre el source de `pulpo.js`: asserteaba la
// FORMA DEL CÓDIGO, no la entrega, y por eso fue estructuralmente incapaz de
// detectar que el fix "texto plano" era un no-op. Omitir `parse_mode` no evita
// el parseo: `servicio-telegram.js` hace `data.parse_mode || 'Markdown'`, así
// que un dropfile sin `parse_mode` se manda IGUAL como Markdown legacy.
//
// Estos tests validan el DROPFILE ENCOLADO contra la resolución real del
// servicio.

const { escapeMarkdownLegacy } = require('../config-schema');

/**
 * Resolución de parse_mode del servicio. Se delega en la función REAL de
 * `servicio-telegram` (pura y exportada) en vez de reimplementarla acá: una
 * copia de la lógica en el test se desincroniza en silencio del source, que es
 * justo lo que este bloque quiere impedir.
 */
const { resolveOutboundParseMode } = require('../../servicio-telegram');

function parseModeEfectivo(dropfilePayload) {
    return resolveOutboundParseMode(dropfilePayload);
}

/**
 * ¿Telegram devolvería `400 can't parse entities` con Markdown legacy?
 * Markdown legacy rompe con delimitadores impares (`_`, `*`, `` ` ``) y con
 * corchetes que abre como link y no cierra. Un `\` delante los neutraliza.
 */
function rompeMarkdownLegacy(text) {
    const sinEscapados = String(text).replace(/\\[_*`[\]]/g, '');
    for (const delim of ['_', '*', '`']) {
        const n = (sinEscapados.split(delim).length - 1);
        if (n % 2 === 1) return true;
    }
    return /\[[^\]]*\](?!\()/.test(sinEscapados) || sinEscapados.includes('[');
}

test('B2: el servicio parsea como Markdown aunque el dropfile omita parse_mode', () => {
    // La premisa que invalidaba el fix anterior, verificada contra la función
    // REAL del servicio. Sigue vigente: OMITIR `parse_mode` no desactiva el
    // parseo — el default histórico lo reinyecta como 'Markdown'. Por eso el
    // fix de este issue (escapar antes de encolar) sigue siendo necesario.
    assert.equal(parseModeEfectivo({ text: 'hola' }), 'Markdown');
    assert.equal(parseModeEfectivo({ text: 'hola', parse_mode: 'MarkdownV2' }), 'MarkdownV2');
});

test('B2: la ausencia de parse_mode NO equivale a texto plano; `plain:true` sí (#5421)', () => {
    // Complemento del test de arriba, y la razón por la que este bloque dejó de
    // mirar el source con un regex: #5421 extrajo la resolución a
    // `resolveOutboundParseMode` y agregó una vía EXPLÍCITA para el texto plano.
    // El regex pineaba la forma del código, no la conducta, y se rompió con el
    // refactor aunque la premisa de #5519 seguía intacta.
    //
    // Las dos cosas conviven y no se pisan:
    //   - omitir `parse_mode`  ⇒ 'Markdown'  (premisa de #5519, arriba)
    //   - declarar `plain:true` ⇒ null       (vía de #5421 para avisos críticos)
    assert.equal(parseModeEfectivo({ text: 'hola', plain: true }), null);
    // `plain` gana sobre un `parse_mode` explícito: es una declaración, no un default.
    assert.equal(parseModeEfectivo({ text: 'hola', plain: true, parse_mode: 'Markdown' }), null);
    // Sólo el booleano `true` cuenta (default cerrado: nada de valores truthy sueltos).
    assert.equal(parseModeEfectivo({ text: 'hola', plain: 'si' }), 'Markdown');
});

test('B2: el aviso con detalle redactado se entrega escapado y no muere en fallido/', () => {
    // Payload REAL del emisor: la redacción de secretos deja `[REDACTED:...]`
    // (corchete que Telegram abre como link) y los skills viajan en snake_case
    // (`_` impar). Es el mensaje de ANOMALIA / HALT_HUMANO / CB_INFRA / DEADLOCK.
    const mensaje = 'Pipeline sin despachar 3h — gate con token '
        + '[REDACTED:high-entropy] y skill pipeline_dev *sin cerrar';

    // (a) Lo que hacía el fix anterior: encolar el texto crudo sin parse_mode.
    const dropfilePlano = { text: mensaje };
    assert.equal(parseModeEfectivo(dropfilePlano), 'Markdown');
    assert.ok(
        rompeMarkdownLegacy(dropfilePlano.text),
        'el "texto plano" se parsea igual como Markdown y da 400 → la alerta muere en fallido/',
    );

    // (b) Lo que hace el fix de rev-5: escapar antes de encolar.
    const dropfileEscapado = { text: escapeMarkdownLegacy(mensaje), parse_mode: 'Markdown' };
    assert.ok(
        !rompeMarkdownLegacy(dropfileEscapado.text),
        `el aviso escapado es entregable: ${dropfileEscapado.text}`,
    );
    // No se perdió información: el texto sigue siendo legible.
    assert.ok(dropfileEscapado.text.includes('REDACTED:high-entropy'));
    assert.ok(dropfileEscapado.text.includes('pipeline'));
});

test('B2: los dos emisores de causa escapan el mensaje antes de encolarlo', () => {
    // Guardia de cableado (complementa, no reemplaza, a los dos de arriba): el
    // `alert` de ambos `publish()` tiene que pasar por el escape.
    const src = fs.readFileSync(PULPO, 'utf8');
    const escapados = src.match(
        /alert:\s*\(m\)\s*=>\s*\{\s*try\s*\{\s*sendTelegram\(configSchema\.escapeMarkdownLegacy\(m\)\)/g,
    ) || [];
    assert.equal(escapados.length, 2, 'los dos call sites de publish() deben escapar el mensaje');
    // Y ninguno puede volver al no-op de "plano".
    const planos = src.match(/alert:\s*\(m\)\s*=>\s*\{\s*try\s*\{\s*sendTelegramPlain\(/g) || [];
    assert.deepEqual(planos, [], 'sendTelegramPlain es un no-op acá: el servicio defaultea a Markdown');
});

// ─── El mensaje del watchdog es seguro por construcción ─────────────────────

test('el aviso del watchdog no lleva metacaracteres aunque la causa los traiga', () => {
    const d = wd.decide({
        now: 200 * MIN,
        waveKey: 7,
        enabledCount: 5,
        dispatching: 0,
        cause: { declared: true, kind: 'raro_*`[caso', readable: true },
        lastDispatchTs: 1,
        state: { lastMovementTs: 1, lastStampTs: 1, lastSignature: null, lastAlertTs: 0, alertCount: 0 },
        stallMinutes: 20,
        declaredCauseEscalateMinutes: 45,
    });
    assert.equal(d.action, 'alert');
    assert.ok(!/[*`[\]]/.test(d.message), d.message);
});
