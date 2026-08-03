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

// ─── B6 · el emisor hermano no puede mandar Markdown crudo ──────────────────

test('B6: los publish de causa del Pulpo encolan en texto plano, no en Markdown', () => {
    // Guardia de código: es exactamente la regresión que ya ocurrió dos veces.
    // `sendTelegram` fija `parse_mode: 'Markdown'`; `sendTelegramPlain` lo omite.
    const src = fs.readFileSync(PULPO, 'utf8');
    const crudos = src.match(/alert:\s*\(m\)\s*=>\s*\{\s*try\s*\{\s*sendTelegram\(/g) || [];
    assert.deepEqual(crudos, [], 'ningún alert de dispatch-cause puede usar sendTelegram (Markdown)');
    const planos = src.match(/alert:\s*\(m\)\s*=>\s*\{\s*try\s*\{\s*sendTelegramPlain\(/g) || [];
    assert.equal(planos.length, 2, 'los dos call sites de publish() deben usar sendTelegramPlain');
});

test('B6: un detalle redactado rompería Markdown legacy — por eso va plano', () => {
    // Reproduce el payload real: la redacción deja `[REDACTED:...]` (corchete sin
    // link) y los skills viajan en snake_case (`_` impar).
    const detalle = 'gate con token [REDACTED:high-entropy] y skill pipeline_dev';
    const corchetesSinLink = /\[[^\]]*\](?!\()/.test(detalle);
    const guionesBajos = (detalle.match(/_/g) || []).length;
    assert.ok(corchetesSinLink, 'hay un corchete que Telegram intenta parsear como link');
    assert.equal(guionesBajos % 2, 1, 'hay un guion bajo impar: itálica sin cerrar');
    // Con `parse_mode: 'Markdown'` esto es un 400 y la alerta muere en fallido/.
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
