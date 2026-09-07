'use strict';

// =============================================================================
// home.test.js — Tests SSR del rediseño del main del Dashboard V3 (#3725).
//
// Cubre los criterios de aceptación del split:
//   - CA-3725.13: smoke por sub-función (state vacío + poblado), payloads XSS
//     en contexto body y atributo, snapshot de IDs DOM ↔ renderClientScript.
//   - CA-3725.3 / CA-3725.6: whitelist sin filtración (infra health / system
//     card) — sin secretos, sin hostname/cwd/env/paths.
//   - CA-3725.8: boundary <main id="view-content"> preservado.
//   - CA-3725.1: build status 'unknown' cuando el marker no existe.
//
// Framework: node --test (estándar del repo, ver lib/__tests__/).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const home = require('../home.js');
const {
    renderHomeHTML,
    renderBrandBar,
    renderControlBar,
    renderInfraHealth,
    renderKpiGrid,
    renderQueueDetailed,
    renderSystemCard,
    // #3954 EP8-H1 — mission control de 3 bandas
    renderSemaforo,
    renderAlertTray,
    renderHealthBand,
    renderNowBand,
    renderFlowBand,
} = home;

// Payloads canónicos (los exige CA-3725.13 / análisis /security).
const XSS_BODY = '<script>alert(1)</script>';
const XSS_DOUBLE = '&#x6a;avascript';            // detecta doble-escape (&amp;#x...)
const XSS_ATTR = '"><img src=x onerror=alert(1)>'; // rompe contexto de atributo

const SUBFNS = {
    renderBrandBar,
    renderControlBar,
    renderInfraHealth,
    renderKpiGrid,
    renderQueueDetailed,
    renderSystemCard,
};

// ---------------------------------------------------------------------------
// Smoke: cada sub-función devuelve string con state vacío y con state poblado.
// ---------------------------------------------------------------------------
test('cada sub-función devuelve string con state vacío (sin throw)', () => {
    for (const [name, fn] of Object.entries(SUBFNS)) {
        const out = fn(undefined);
        assert.equal(typeof out, 'string', name + ' debe devolver string');
        assert.ok(out.length > 0, name + ' debe devolver markup no vacío');
    }
});

test('cada sub-función devuelve string con state {} (sin throw)', () => {
    for (const [name, fn] of Object.entries(SUBFNS)) {
        const out = fn({});
        assert.equal(typeof out, 'string', name + ' con {} debe devolver string');
    }
});

test('renderBrandBar poblado emite identidad y selector sin mezclar build', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: 'main', commit: 'abc1234' } });
    assert.match(out, /MIZP/);
    assert.match(out, /id="mz-projsel"/);
    assert.doesNotMatch(out, /id="bld-status"/);
    assert.doesNotMatch(out, /Build OK/);
});

test('renderInfraHealth poblado emite UP/DOWN + filas por servicio', () => {
    const out = renderInfraHealth({
        infra: {
            pulpo: { status: 'UP', lastPing: '2026-06-06T10:00:00Z' },
            dashboard: { status: 'UP', lastPing: '2026-06-06T10:00:00Z' },
            telegram: { status: 'DOWN', lastPing: null },
        },
    });
    assert.match(out, /id="infra-pulpo"/);
    assert.match(out, /id="infra-dashboard"/);
    assert.match(out, /id="infra-telegram"/);
    assert.match(out, /UP/);
    assert.match(out, /DOWN/);
});

test('renderSystemCard poblado emite las 4 celdas whitelisted', () => {
    const out = renderSystemCard({ system: { cpuPct: 42, memPct: 71, diskPct: 55, uptimeS: 3661 } });
    assert.match(out, /id="sys-cpu-value"/);
    assert.match(out, /id="sys-mem-value"/);
    assert.match(out, /id="sys-disk-value"/);
    assert.match(out, /id="sys-uptime-value"/);
    assert.match(out, /42%/);
    assert.match(out, /1h 1m/); // 3661s → 1h 1m
});

// ---------------------------------------------------------------------------
// CA-3725.1 — build status 'unknown' degradado cuando el marker no existe.
// ---------------------------------------------------------------------------
test('renderHomeHTML sin build status muestra fallback explícito sin romper', () => {
    const out = renderHomeHTML({});
    assert.match(out, /id="bld-status"/);
    assert.match(out, /Build sin datos/);
    assert.match(out, /in-pill-info/);
    assert.doesNotMatch(out, /Build \?/);
});

test('renderHomeHTML nunca invoca gh api (R-G4) — sin la cadena en el markup', () => {
    const out = renderHomeHTML({});
    assert.ok(!/gh api/.test(out) || /sin gh api/.test(out),
        'el markup no debe sugerir invocación de gh api salvo en la nota explicativa');
});

// ---------------------------------------------------------------------------
// CA-3725.13 — XSS en contexto BODY: el payload de build ya no se interpola en
// SSR. El detalle branch/commit se hidrata por textContent/title en el cliente.
// ---------------------------------------------------------------------------
test('XSS body: renderBrandBar no interpola branch en la marca', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: XSS_BODY, commit: '' } });
    assert.ok(!out.includes(XSS_BODY), 'el <script> crudo NO debe aparecer en el body');
    assert.doesNotMatch(out, /&lt;script&gt;/, 'la marca no debe renderizar detalle de build');
});

test('XSS body: sin doble-escape de entidades existentes', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: XSS_DOUBLE, commit: '' } });
    // El & del payload se escapa una sola vez a &amp; — no debe quedar &amp;amp;.
    assert.ok(!out.includes('&amp;amp;'), 'no debe haber doble-escape');
});

// ---------------------------------------------------------------------------
// CA-3725.13 / CA-3725.10 — XSS en contexto ATRIBUTO: branch no entra al SSR.
// ---------------------------------------------------------------------------
test('XSS atributo: renderBrandBar no interpola branch en title/aria-label', () => {
    const out = renderBrandBar({ build: { status: 'passing', branch: XSS_ATTR, commit: '' } });
    // El payload rompe-atributo no debe aparecer crudo dentro de un valor.
    assert.ok(!out.includes('onerror=alert(1)>'), 'el payload no debe romper el atributo');
    assert.ok(!out.includes('&quot;'), 'la marca no debe renderizar detalle de build en atributos');
});

test('XSS atributo: renderSystemCard escapa tooltips (defensa, tips estáticos)', () => {
    // Los tips son estáticos, pero validamos que pasan por escapeHtmlAttr.
    const out = renderSystemCard({ system: { cpuPct: null, memPct: null, diskPct: null, uptimeS: 0 } });
    assert.ok(!out.includes('"">'), 'no debe haber atributos rotos');
});

// ---------------------------------------------------------------------------
// CA-3725.3 — Infra health: whitelist estricta, sin secretos.
// ---------------------------------------------------------------------------
test('infra health no filtra token/chat_id/config aunque el state los traiga', () => {
    // Aunque el composer NUNCA pasa estos campos, la sub-función no debe
    // emitirlos si por error llegaran en el objeto.
    const out = renderInfraHealth({
        infra: {
            pulpo: { status: 'UP', lastPing: null },
            dashboard: { status: 'UP', lastPing: null },
            telegram: { status: 'UP', lastPing: null, token: 'SECRET-TOKEN-123', chat_id: '999' },
        },
    });
    assert.ok(!out.includes('SECRET-TOKEN-123'), 'el token NUNCA debe aparecer');
    assert.ok(!out.includes('999'), 'el chat_id NUNCA debe aparecer');
    assert.ok(!/token|chat_id/i.test(out.replace(/sin exponer token ni chat_id/i, '')),
        'no debe emitir claves token/chat_id (salvo la nota del tooltip)');
});

// ---------------------------------------------------------------------------
// CA-3725.6 — System card: prohibido hostname/cwd/userInfo/env/paths.
// ---------------------------------------------------------------------------
test('system card no filtra hostname/cwd/env aunque el state los traiga', () => {
    const out = renderSystemCard({
        system: {
            cpuPct: 10, memPct: 20, diskPct: 30, uptimeS: 100,
            hostname: 'EVIL-HOST', cwd: 'C:/secret/path', user: 'admin',
        },
    });
    assert.ok(!out.includes('EVIL-HOST'), 'no debe emitir hostname');
    assert.ok(!out.includes('C:/secret/path'), 'no debe emitir paths');
    assert.ok(!out.includes('admin'), 'no debe emitir usuario');
});

// ---------------------------------------------------------------------------
// CA-3725.8 / CA-3725.14 — render completo: boundary + sin leaks de infra.
// ---------------------------------------------------------------------------
test('renderHomeHTML preserva el boundary main#view-content', () => {
    const html = renderHomeHTML({});
    assert.match(html, /<main[^>]*id="view-content"/);
});

test('renderHomeHTML no filtra process.env / hostname / cwd / paths del host', () => {
    const html = renderHomeHTML({});
    assert.ok(!html.includes('process.env'), 'no debe contener process.env');
    assert.ok(!/[A-Za-z]:\\\\Users\\\\/.test(html), 'no debe contener paths absolutos de Windows');
    assert.ok(!/\/home\/[a-z]/.test(html), 'no debe contener paths /home');
    // hostname/cwd como labels indicativas de leak.
    assert.ok(!/hostname:/.test(html), 'no debe contener hostname:');
    assert.ok(!/cwd:/.test(html), 'no debe contener cwd:');
});

test('renderHomeHTML respeta currentView y flag unknownView (sin reflejar slug)', () => {
    const html = renderHomeHTML({ currentView: 'home', unknownViewRequested: true });
    assert.match(html, /data-current-view="home"/);
    assert.match(html, /"unknownViewRequested":true/);
});

// ---------------------------------------------------------------------------
// CA-3725.13 (R-G1) — Snapshot de acoplamiento: todo ID referenciado por el
// script cliente (getElementById/setText/setClass con literal completo) debe
// existir como id="..." en el HTML SSR. Si no, el refresh queda muerto en
// silencio. Excepciones documentadas: elementos creados en runtime por JS.
// ---------------------------------------------------------------------------
test('snapshot IDs: cada referencia literal del client script existe en SSR', () => {
    const html = renderHomeHTML({});
    const src = fs.readFileSync(path.join(__dirname, '..', 'home.js'), 'utf8');

    // Elementos creados dinámicamente por el cliente (no viven en el SSR):
    //   - in-toast: lo crea showToast() on-demand.
    //   - wave-planned-overflow: lo crea morphWaveRow() al poblar la ola.
    const RUNTIME_CREATED = new Set(['in-toast', 'wave-planned-overflow']);

    const ids = new Set();
    const re = /(?:getElementById\(\s*'([a-zA-Z0-9_-]+)'\s*\)|(?:setText|setClass)\(\s*'([a-zA-Z0-9_-]+)'\s*,)/g;
    let m;
    while ((m = re.exec(src))) ids.add(m[1] || m[2]);

    const dangling = [...ids]
        .filter((id) => !RUNTIME_CREATED.has(id))
        .filter((id) => !html.includes('id="' + id + '"'));

    assert.deepEqual(dangling, [],
        'IDs referenciados por el script pero ausentes en SSR (R-G1): ' + JSON.stringify(dangling));
});

// =============================================================================
// #3954 EP8-H1 — Mission control de 3 bandas (Salud / Ahora / Flujo).
// CA-1 (grid sin scroll de página), CA-2 (semáforo explicable, razones
// escapadas REQ-SEC-6), CA-5 (bandeja reemplaza banners), CA-11 (deep-links
// reflejados escapados REQ-SEC-5).
// =============================================================================

// #4189 — El home «MIZPÁ» (mockup v6) reemplaza las 3 bandas (#4172) por:
// banner de misión → nav curada → panel estado+cuotas → grilla 2-col → diag.
// El wrapper conserva id="mission-grid" para que _applyMissionFrame() siga
// detectando el home sin tocar el cliente (R-G1).
test('#4189: renderHomeHTML emite el layout MIZPÁ (banner + panel + grilla 2-col)', () => {
    const html = renderHomeHTML({});
    assert.ok(html.includes('class="mz-home" id="mission-grid"'),
        'el wrapper MIZPÁ conserva id="mission-grid" (compat _applyMissionFrame)');
    assert.ok(html.includes('id="mz-mission"'), 'banner de misión con ola protagonista');
    assert.ok(html.includes('id="mission-wave-num"') && html.includes('id="mission-avance-pct"')
        && html.includes('id="mission-eta-value"') && html.includes('id="mission-delivered-value"'),
        'el banner expone número de ola, avance, ETA y entregados (hidratables)');
    assert.ok(html.includes('class="mz-sysquota"'), 'panel estado + cuotas');
    // #4533 — el panel pasó a matriz de cuota DISPONIBLE por proveedor × ventana
    // (corta/larga). Ya no hay % agregado (mz-quota-session-pct removido); cada
    // proveedor tiene dos celdas de ventana (short/long) con ids mz-qm-<key>-<slot>-*.
    assert.ok(html.includes('id="mz-sig-healthy"'),
        'estado compacto con señal accionable "proveedores sanos"');
    // #4249/#4533: la matriz usa los ids canónicos de ALLOWED_PROVIDERS
    // (openai-codex, gemini-google, etc.). Se renderizan los 5 proveedores activos
    // en su ventana corta (short) y larga (long).
    assert.ok(html.includes('id="mz-qm-anthropic-short-bar"') && html.includes('id="mz-qm-anthropic-long-bar"')
        && html.includes('id="mz-qm-openai-codex-short-bar"')
        && html.includes('id="mz-qm-gemini-google-short-bar"')
        && html.includes('id="mz-qm-cerebras-long-bar"')
        && html.includes('id="mz-qm-nvidia-nim-long-bar"'),
        'matriz proveedor×ventana con ids canónicos Anthropic/Codex/Gemini/Cerebras/NVIDIA NIM (CA-6, #4533)');
    assert.ok(html.includes('class="mz-grid"'), 'grilla de 2 columnas');
    assert.ok(html.includes('class="mz-panel mz-now"') && html.includes('class="mz-panel mz-board"'),
        'columna Ahora·Ejecución + Tablero de la Ola');
    // Los IDs invariantes de los tickers siguen presentes (varios en el <details> de diag).
    assert.ok(html.includes('id="active-list"') && html.includes('id="wave-panel"')
        && html.includes('id="semaforo-global"') && html.includes('id="kpi-quota"'),
        'sub-componentes con IDs hidratables preservados (telemetría viva)');
});

// =============================================================================
// #4235 — Marco común MIZPÁ en HOME. La «cabecera de ola» (banner de misión)
// debe REUTILIZAR el helper compartido `renderMissionBannerPipeline()` que
// entregó #4234, no una copia byte-a-byte del markup. Este contrato evita que
// HOME y el resto de las pantallas vuelvan a divergir (CA: «no se duplica
// markup / reutilizar helpers compartidos del marco MIZPÁ»).
// =============================================================================
test('#4235: la cabecera de ola de HOME reutiliza el helper común (paridad exacta)', () => {
    const pr = require('../pipeline-redesign.js');
    const homeBanner = home.renderMissionBanner({});
    const sharedBanner = pr.renderMissionBannerPipeline();
    assert.equal(homeBanner, sharedBanner,
        'renderMissionBanner debe delegar en renderMissionBannerPipeline (markup idéntico, sin duplicar)');
});

test('#4235: HOME muestra los tres bloques del marco común MIZPÁ', () => {
    const html = renderHomeHTML({});
    // ① Cabecera MIZPÁ: marca + selector de proyecto + Pulpo / CPU·RAM / reloj.
    assert.ok(html.includes('class="mz-logo"') && html.includes('>MIZPÁ<')
        && html.includes('id="mz-projsel"'),
        '① cabecera MIZPÁ con marca y selector de proyecto');
    assert.ok(html.includes('id="hdr-pulpo"') && html.includes('id="hdr-resources"')
        && html.includes('id="hdr-clock"'),
        '① Pulpo / CPU·RAM / reloj');
    // ② Cabecera de ola: tag + título + métricas + bloque AVANCE con leyenda.
    assert.ok(html.includes('class="mz-wavetag-k"') && html.includes('id="mission-eta-value"')
        && html.includes('id="mission-vel-value"') && html.includes('id="mission-delivered-value"'),
        '② cabecera de ola con tag y métricas (ETA · velocidad · entregados)');
    assert.ok(html.includes('>AVANCE<') && html.includes('id="mission-leg-done"')
        && html.includes('id="mission-leg-active"') && html.includes('id="mission-leg-blocked"')
        && html.includes('id="mission-leg-queue"'),
        '② bloque AVANCE con leyenda de puntitos (hechos · activos · bloq · cola)');
    // ③ Barra de accesos a subventanas: la nav compartida v3-nav.
    assert.ok(html.includes('class="v3-nav"'),
        '③ barra de accesos a subventanas (nav común v3-nav)');
});

test('CA-3: semáforo sano informa "sin degradaciones"', () => {
    const out = renderSemaforo({ semaforo: { level: 'ok', label: 'SALUDABLE', reasons: [] } });
    assert.ok(out.includes('Sin degradaciones'));
    assert.ok(out.includes('id="semaforo-global"'));
});

test('CA-2 / REQ-SEC-6: el tooltip del semáforo enumera razones ESCAPADAS', () => {
    const out = renderSemaforo({
        semaforo: {
            level: 'alert', label: 'CRITICO',
            reasons: [
                { code: 'x', level: 'alert', text: '<script>alert(1)</script>' },
                { code: 'y', level: 'warn', text: 'Cuota agotada' },
            ],
        },
    });
    assert.ok(!out.includes('<script>alert(1)</script>'), 'no debe reflejar el payload crudo');
    assert.ok(out.includes('&lt;script&gt;'), 'la razón XSS debe salir escapada');
    assert.ok(out.includes('Cuota agotada'), 'enumera la segunda razón');
});

test('CA-5: la bandeja reemplaza banners y emite ack + snooze (allowlist 1/4/24)', () => {
    const state = {
        semaforo: { level: 'warn', reasons: [{ code: 'cuota:exhausted', level: 'warn', text: 'Cuota agotada' }] },
        alertSuppressions: {},
    };
    const out = renderAlertTray(state);
    assert.ok(out.includes('id="alert-tray-list"'), 'hay bandeja de alertas');
    assert.ok(out.includes('data-alert-action="ack"'), 'botón ack');
    assert.ok(/data-alert-action="snooze" data-alert-hours="1"/.test(out), 'snooze 1h');
    assert.ok(/data-alert-hours="4"/.test(out), 'snooze 4h');
    assert.ok(/data-alert-hours="24"/.test(out), 'snooze 24h');
    // El home no debe seguir mostrando los banners legacy dispersos como sección.
    assert.ok(!out.includes('infra-health'), 'la bandeja no es el banner de infra');
});

test('CA-5 / REQ-SEC-3: la bandeja muestra "quién atendió" desde supresiones server-side', () => {
    const state = {
        semaforo: { level: 'warn', reasons: [{ code: 'cuota:exhausted', level: 'warn', text: 'Cuota agotada' }] },
        alertSuppressions: { 'cuota:exhausted': { action: 'ack', actor: 'operador-local', timestamp: '2026-06-15T12:00:00Z', snoozeUntil: null } },
    };
    const out = renderAlertTray(state);
    assert.ok(out.includes('operador-local'), 'muestra el actor server-side');
});

test('CA-5 / REQ-SEC-5: alert id con payload XSS se escapa en data-attr', () => {
    const state = {
        semaforo: { level: 'alert', reasons: [{ code: '"><img src=x onerror=alert(1)>', level: 'alert', text: 'mal' }] },
        alertSuppressions: {},
    };
    const out = renderAlertTray(state);
    assert.ok(!out.includes('<img src=x onerror=alert(1)>'), 'no refleja el payload crudo en el atributo');
});

test('CA-11 / REQ-SEC-5: deep-link inválido NO se refleja; válido viaja escapado en boot', () => {
    const evil = renderHomeHTML({ selectedAlert: '"><script>alert(1)</script>' });
    assert.ok(!evil.includes('<script>alert(1)</script>'), 'un deep-link inválido nunca se refleja crudo');
    const good = renderHomeHTML({ selectedAlert: 'cuota:exhausted' });
    assert.ok(good.includes('"selected"') && good.includes('cuota:exhausted'),
        'un deep-link válido viaja en __VIEW_BOOT__.selected');
});

test('las bandas no lanzan con state vacío', () => {
    for (const fn of [renderSemaforo, renderAlertTray, renderHealthBand, renderNowBand, renderFlowBand]) {
        assert.equal(typeof fn({}), 'string');
        assert.equal(typeof fn({ semaforo: { reasons: [] } }), 'string');
    }
});

// =============================================================================
// #6708 (rebote QA) — Indicador de disco en la SUPERFICIE SERVIDA.
//
// El intento anterior construyó el gauge dentro de `resourcesHTML` de
// dashboard.js: una constante que se asigna y nunca se interpola en el HTML de
// salida. El código existía, los tests del módulo pasaban, y el operador seguía
// viendo "—". Por eso el test que importa NO es "renderSystemCard devuelve
// algo", sino "el markup del home — lo que sirve `/` — contiene el dato".
// =============================================================================

const DISK_ORANGE = {
    level: 'orange',
    color: '#db6d28',
    freeGB: 18.88,
    totalGB: 235.5,
    frozen: false,
    budget: { green_gb: 40, yellow_gb: 25, orange_gb: 12 },
    measuredAt: '2026-08-29T02:09:34.789Z',
};

test('#6708 CA: el home SERVIDO muestra el espacio libre con el color del umbral', () => {
    const out = renderHomeHTML({ system: { cpuPct: null, memPct: null, disk: DISK_ORANGE, uptimeS: 60 } });
    assert.match(out, /id="sys-disk-value"/, 'la celda de disco debe existir en el markup del home');
    assert.match(out, /18\.9 GB/, 'debe mostrar los GB LIBRES, no el % usado');
    assert.match(out, /id="sys-disk-value" style="color:#db6d28"/,
        'el valor debe llevar el color del umbral vigente (orange)');
    // Regresión dura del rebote: el dato no puede quedar en '—' con medición viva.
    assert.doesNotMatch(out, /id="sys-disk-value"[^>]*>—</, 'con medición no puede quedar en guión');
});

test('#6708 la celda de disco lleva señal no-cromática (emoji de nivel) y tooltip con la escala', () => {
    const out = renderSystemCard({ system: { disk: DISK_ORANGE } });
    assert.ok(out.includes('\u{1F7E0} 18.9 GB'), 'el nivel se comunica también por forma, no sólo por color');
    assert.match(out, /Disco libre/);
    assert.match(out, /Nivel orange/);
    assert.match(out, /verde &gt;40 · amarillo &gt;25 · naranja &gt;12 GB libres/,
        'el tooltip explica el presupuesto vigente de disk_budget');
});

test('#6708 cada nivel del presupuesto pinta su propio color', () => {
    const casos = [
        { level: 'green',  color: '#3fb950', emoji: '\u{1F7E2}' },
        { level: 'yellow', color: '#d29922', emoji: '\u{1F7E1}' },
        { level: 'orange', color: '#db6d28', emoji: '\u{1F7E0}' },
        { level: 'red',    color: '#f85149', emoji: '\u{1F534}' },
    ];
    for (const c of casos) {
        const out = renderSystemCard({ system: { disk: Object.assign({}, DISK_ORANGE, c) } });
        assert.ok(out.includes('style="color:' + c.color + '"'), 'nivel ' + c.level + ' → ' + c.color);
        assert.ok(out.includes(c.emoji), 'nivel ' + c.level + ' → emoji propio');
    }
});

test('#6708 sin medición el disco muestra guión y NO inventa un color', () => {
    const out = renderSystemCard({ system: { cpuPct: 10, memPct: 20, uptimeS: 5 } });
    assert.match(out, /id="sys-disk-value">—</, 'sin dato va guión, no ceros ni verde');
    assert.doesNotMatch(out, /id="sys-disk-value" style/, 'sin medición no se pinta color alguno');
    assert.match(out, /Sin medición todavía/);
});

test('#6708 el freno de fases pesadas por disco se explica en el tooltip', () => {
    const out = renderSystemCard({ system: { disk: Object.assign({}, DISK_ORANGE, { level: 'red', color: '#f85149', freeGB: 8.2, frozen: true }) } });
    assert.match(out, /8\.2 GB/);
    assert.match(out, /FRENADO por falta de disco/);
});

test('#6708 SEC: un `color` no-hex del estado en disco NO se interpola como CSS', () => {
    const evil = Object.assign({}, DISK_ORANGE, { color: 'red;background:url(javascript:alert(1))' });
    const out = renderSystemCard({ system: { disk: evil } });
    assert.doesNotMatch(out, /id="sys-disk-value" style/, 'color no-hex genera markup sin atributo style');
    assert.ok(!out.includes('javascript:alert(1)'), 'el payload no llega crudo al markup');
    // El dato sigue viéndose aunque el color sea inválido (degradación, no página rota).
    assert.match(out, /18\.9 GB/);
});

test('#6708 el freeGB no numérico degrada a guión sin lanzar', () => {
    for (const bad of [null, undefined, NaN, 'mucho', Infinity]) {
        const out = renderSystemCard({ system: { disk: Object.assign({}, DISK_ORANGE, { freeGB: bad }) } });
        assert.match(out, /id="sys-disk-value">—</, 'freeGB=' + String(bad));
    }
});

test('#6708 el script cliente hidrata sys-disk-value desde resources.disk del header', () => {
    const script = home.renderClientScript();
    assert.ok(script.includes("getElementById('sys-disk-value')"),
        'la hidratación debe tocar la celda por su id');
    assert.ok(/res\.disk|resources\.disk/.test(script),
        'el dato sale del MISMO slice de resources (/api/dash/header), sin endpoint extra');
});

test('#6708 regresión: dashboard.js no cuelga el disco del bloque muerto resourcesHTML', () => {
    const dash = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'dashboard.js'), 'utf8');
    assert.ok(!dash.includes('diskHTML'),
        'el gauge de disco no debe vivir en `resourcesHTML`, que se asigna y nunca se interpola');
});
