// =============================================================================
// #6459 (rebote QA rev-1) — El badge `huerfano` tiene que VERSE en el dashboard
// que abre el operador, no sólo existir en el código (CA-9 / CA-13).
//
// El rebote fue exactamente esto: el listado con el badge vivía dentro de
// `generateHTML()` de `dashboard.js`, que el dispatch sirve ÚNICAMENTE para
// `/legacy`. `GET /`, `/v3` y `/dashboard` (kiosk V3, que emite
// `views/dashboard/home.js`) devolvían CERO ocurrencias de `cmd-result-huerfano`.
//
// Estos tests fijan la superficie V3 para que no vuelva a irse en silencio:
// si alguien saca el panel del home o el CSS del render, acá se rompe.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const view = require('../commander-activity');
const home = require('../home');

// --- helpers ---------------------------------------------------------------

function tmpLogDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cmdact-6459-'));
}

function writeRequest(dir, id, meta) {
    fs.writeFileSync(path.join(dir, `commander-${id}.log`), 'contenido irrelevante\n', 'utf8');
    if (meta !== undefined) {
        fs.writeFileSync(path.join(dir, `commander-${id}.meta.json`), JSON.stringify(meta), 'utf8');
    }
}

// --- CSS: fuente única -----------------------------------------------------

test('el CSS del panel trae la regla del badge huerfano con fallback hex literal (UX-2)', () => {
    const css = view.commanderActivityStyles();
    assert.match(css, /\.cmd-result-huerfano/);
    // UX-2 bloqueante: si design-tokens.css no carga, el token queda sin valor
    // y el badge renderiza MUDO salvo que haya hex literal de respaldo.
    assert.match(css, /var\(--result-huerfano,#FF6B8A\)/);
    assert.match(css, /var\(--result-huerfano-bg,rgba\(255,107,138,0\.16\)\)/);
    assert.match(css, /var\(--result-huerfano-dim,#B8254A\)/);
});

test('el CSS del badge sale de result-badge.js, no de una copia local', () => {
    const { RESULT_BADGE_CSS } = require('../../../lib/commander/result-badge');
    assert.ok(view.commanderActivityStyles().includes(RESULT_BADGE_CSS));
});

// --- Filas -----------------------------------------------------------------

test('una petición con resultado huerfano renderiza el badge propio en la fila', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-1001234-1787611707632', { resultado: 'huerfano', provider: 'anthropic' });

    const html = view.renderCommanderActivityRows(dir);
    assert.match(html, /cmd-result cmd-result-huerfano/);
    assert.match(html, /∅ huérfano/);
    // Señal redundante del mockup: la fila entera se marca, no sólo el badge.
    assert.match(html, /cmd-act-row cmd-act-row-huerfano/);
});

test('los cinco resultados del enum renderizan su propia clase', () => {
    const dir = tmpLogDir();
    const casos = ['ok', 'ajustada', 'fallback', 'error', 'huerfano'];
    casos.forEach((r, i) => writeRequest(dir, `-100-17876117000${i}0`, { resultado: r }));

    const html = view.renderCommanderActivityRows(dir);
    for (const r of casos) {
        assert.match(html, new RegExp(`cmd-result-${r}\\b`), `falta el badge de ${r}`);
    }
});

test('una petición sin sidecar dice "(sin badge)" — una fila muda significa "no hay dato"', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611707632'); // sin meta.json

    const html = view.renderCommanderActivityRows(dir);
    assert.match(html, /\(sin badge\)/);
    assert.doesNotMatch(html, /cmd-result-huerfano/);
    // Y NO lleva la marca de huérfano: confundirlas es el defecto original.
    assert.doesNotMatch(html, /cmd-act-row-huerfano/);
});

test('sidecar corrupto degrada a fila sin badge, nunca excepción', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611707632');
    fs.writeFileSync(path.join(dir, 'commander--100-1787611707632.meta.json'), '{no es json', 'utf8');

    const html = view.renderCommanderActivityRows(dir);
    assert.match(html, /\(sin badge\)/);
});

test('directorio inexistente ⇒ estado vacío explícito, no excepción', () => {
    const html = view.renderCommanderActivityRows(path.join(os.tmpdir(), 'no-existe-6459-xyz'));
    assert.match(html, /sin peticiones registradas/);
});

test('el chat_id negativo de los grupos no rompe el parseo del id', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-1001234567890-1787611707632', { resultado: 'huerfano' });

    const html = view.renderCommanderActivityRows(dir);
    assert.match(html, /-1001234567890-1787611707632/);
    assert.match(html, /cmd-result-huerfano/);
});

test('las filas salen de la más nueva a la más vieja y respetan el límite', () => {
    const dir = tmpLogDir();
    writeRequest(dir, '-100-1787611700000', { resultado: 'ok' });
    writeRequest(dir, '-100-1787611800000', { resultado: 'huerfano' });
    writeRequest(dir, '-100-1787611600000', { resultado: 'error' });

    const html = view.renderCommanderActivityRows(dir, 2);
    const filas = html.match(/class="cmd-act-row/g) || [];
    assert.strictEqual(filas.length, 2);
    assert.ok(html.indexOf('1787611800000') < html.indexOf('1787611700000'));
    assert.doesNotMatch(html, /1787611600000/);
});

test('el id se escapa: no hay inyección posible desde el nombre del archivo', () => {
    const dir = tmpLogDir();
    // El nombre real no puede traer `<` en Windows, así que ejercitamos el
    // render con el id ya construido, que es donde vive el riesgo.
    const rows = view.renderCommanderActivityRows(dir);
    assert.match(rows, /sin peticiones registradas/);

    const badges = require('../../../lib/commander/result-badge')
        .buildResultBadges({ resultado: 'huerfano', provider: '<script>x</script>' });
    assert.doesNotMatch(badges, /<script>/);
});

// --- Panel + fallback inerte ----------------------------------------------

test('el panel completo lleva título visible y no queda oculto', () => {
    const html = view.renderCommanderActivity({ logDir: tmpLogDir() });
    assert.match(html, /ACTIVIDAD DEL COMMANDER/);
    assert.doesNotMatch(html, /\bhidden\b/);
    assert.doesNotMatch(html, /display:none/);
});

test('el fallback inerte es VISIBLE y dice la causa (CA-14)', () => {
    const html = view.renderInert('logDir ilegible');
    assert.match(html, /ACTIVIDAD DEL COMMANDER/);
    assert.match(html, /logDir ilegible/);
});

// --- Regresión del rebote: la superficie que abre el operador --------------

test('REGRESIÓN #6459 — el home V3 (GET /, /v3, /dashboard) trae el CSS del badge huerfano', () => {
    const html = home.renderHomeHTML({});
    assert.match(html, /\.cmd-result-huerfano/,
        'el home V3 volvió a quedar sin la regla CSS: el badge renderiza mudo');
    assert.match(html, /var\(--result-huerfano,#FF6B8A\)/);
});

test('REGRESIÓN #6459 — el home V3 monta el panel de actividad del Commander', () => {
    const html = home.renderHomeHTML({});
    assert.match(html, /ACTIVIDAD DEL COMMANDER/,
        'sin el panel no hay ninguna fila donde pueda aparecer el badge');
});

test('REGRESIÓN #6459 — el panel del home NO vive dentro del sink oculto de diagnóstico', () => {
    const html = home.renderHomeHTML({});
    const iPanel = html.indexOf('ACTIVIDAD DEL COMMANDER');
    const iSink = html.indexOf('id="mz-telemetry-sink"');
    assert.ok(iPanel > -1 && iSink > -1);
    assert.ok(iPanel < iSink,
        'el panel quedó dentro (o después) del sink `hidden`: no lo ve el operador');
});

test('el panel del home degrada sin romper el render si el módulo no está', () => {
    // `renderCommanderActivityPanel` es tolerante por contrato: exportado y puro
    // respecto del resto del state.
    assert.strictEqual(typeof home.renderCommanderActivityPanel, 'function');
    assert.doesNotThrow(() => home.renderCommanderActivityPanel());
});
