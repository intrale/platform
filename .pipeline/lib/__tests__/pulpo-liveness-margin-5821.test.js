// =============================================================================
// pulpo-liveness-margin-5821.test.js — #5821
//
// Qué se está protegiendo acá
// ---------------------------
// El 2026-08-11 el watchdog mató y relanzó al Pulpo 77 veces en 3 horas porque
// el umbral de liveness (180s) era MENOR que la duración real de un ciclo. Se
// subió a 270s, pero el pico observado fue 245s: ~9% de margen, un empate.
// Y el modo de falla SE VE COMO OTRA COSA — lo que llega al operador es "el
// Commander no responde", no "el watchdog está matando un proceso sano".
//
// Estos tests cubren los cuatro escenarios Gherkin del issue más los invariantes
// de seguridad que NO pueden romperse aunque el resto cambie:
//
//   INV-1  El umbral efectivo NUNCA queda por debajo del piso configurado, y
//          NUNCA resuelve a "nunca stale" (regla SEC-2 de #4154/#5172).
//   INV-2  Con evidencia insuficiente el umbral se queda en el piso — jamás se
//          afloja a ciegas.
//   INV-3  El techo anti-realimentación corta el lazo cuelgue → p99 ↑ → umbral ↑
//          → se tolera el próximo cuelgue → ... (el watchdog ciego en silencio).
//   INV-4  La señal de progreso ausente o ilegible NUNCA inhibe un kill.
//
// Los tests de integración replican el pipeline en un tmpdir con shims (mismo
// patrón que `config-failclosed-runners-5172.test.js`): los runners fijan su
// raíz a `__dirname` a propósito y no se debilita ese hardening con un override
// test-only.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seedProductManifest } = require('./_test-helpers');

const margin = require('../pulpo-liveness-margin');
const liveness = require('../pulpo-liveness');

const PIPELINE_DIR = path.join(__dirname, '..', '..');
const REAL_LIB = path.join(PIPELINE_DIR, 'lib');
const RUNNER = 'pulpo-liveness-run.js';

// =============================================================================
// Parte 1 — Umbral efectivo (CA-2 / CA-3)
// =============================================================================

test('umbral efectivo — con evidencia insuficiente se queda en el PISO (INV-2)', () => {
    const r = margin.computeEffectiveThreshold({
        samples: [10000, 20000, 30000], // 3 muestras contra un mínimo de 100
        floorSeconds: 270,
        minSamples: 100,
    });
    assert.strictEqual(r.effectiveSeconds, 270);
    assert.strictEqual(r.source, 'floor-insufficient-samples');
    // Un p99 sobre 3 muestras degenera en "el máximo": no debe mover nada.
    assert.strictEqual(r.percentileMs, null);
});

test('umbral efectivo — se deriva del percentil × factor cuando hay evidencia', () => {
    // 100 ciclos de 200s. p99 = 200000ms, factor 2 => 400s, que supera el piso.
    const samples = new Array(100).fill(200000);
    const r = margin.computeEffectiveThreshold({
        samples,
        floorSeconds: 270,
        factor: 2,
        percentile: 99,
        minSamples: 100,
        maxEffectiveSeconds: 900,
    });
    assert.strictEqual(r.effectiveSeconds, 400);
    assert.strictEqual(r.source, 'percentile');
    assert.strictEqual(r.sampleCount, 100);
});

test('umbral efectivo — el PISO gana si el percentil daría menos (INV-1)', () => {
    // Ciclos cortos: p99 × 2 = 100s, muy por debajo del piso declarado.
    const samples = new Array(100).fill(50000);
    const r = margin.computeEffectiveThreshold({
        samples,
        floorSeconds: 270,
        factor: 2,
        minSamples: 100,
    });
    assert.strictEqual(r.effectiveSeconds, 270);
    assert.strictEqual(r.source, 'floor');
});

test('umbral efectivo — el TECHO corta la realimentación cuelgue→p99→umbral (INV-3)', () => {
    // Un cuelgue de 1 hora entra a la serie. Sin techo, el umbral saltaría a
    // 2h y el watchdog quedaría ciego para el próximo cuelgue... y el siguiente.
    const samples = new Array(100).fill(3600000);
    const r = margin.computeEffectiveThreshold({
        samples,
        floorSeconds: 270,
        factor: 2,
        minSamples: 100,
        maxEffectiveSeconds: 900,
    });
    assert.strictEqual(r.effectiveSeconds, 900);
    assert.strictEqual(r.source, 'cap');
});

test('umbral efectivo — el techo NUNCA baja del piso (INV-1 sobre config incoherente)', () => {
    // Operador con un piso mayor al techo: config incoherente, pero el
    // invariante manda — jamás se mata con un umbral menor al declarado.
    const r = margin.computeEffectiveThreshold({
        samples: new Array(100).fill(10000),
        floorSeconds: 1200,
        maxEffectiveSeconds: 900,
        minSamples: 100,
    });
    assert.ok(r.effectiveSeconds >= 1200, `esperaba >= 1200, fue ${r.effectiveSeconds}`);
});

test('umbral efectivo — config basura NUNCA produce "nunca stale" (CA-3, fail-closed)', () => {
    // Escenario Gherkin: "config invalida no desactiva el watchdog".
    const basuras = [null, undefined, '', 'abc', 0, -5, NaN, Infinity, {}, [], '0'];
    for (const basura of basuras) {
        const r = margin.computeEffectiveThreshold({
            samples: new Array(200).fill(10000),
            floorSeconds: basura,
            factor: basura,
            percentile: basura,
            maxEffectiveSeconds: basura,
            minSamples: basura,
        });
        assert.ok(
            Number.isInteger(r.effectiveSeconds) && r.effectiveSeconds >= 1,
            `basura=${String(basura)} produjo un umbral no utilizable: ${r.effectiveSeconds}`,
        );
        assert.ok(
            Number.isFinite(r.effectiveSeconds),
            `basura=${String(basura)} produjo un umbral infinito ("nunca stale")`,
        );
        // Con floor inválido cae al default documentado del módulo de liveness.
        assert.ok(r.effectiveSeconds >= liveness.DEFAULT_KILL_SECONDS);
    }
});

test('parseFactor — un factor < 1 dejaría el umbral por debajo del percentil: se rechaza', () => {
    assert.strictEqual(margin.parseFactor(0.5, 2), 2);
    assert.strictEqual(margin.parseFactor(-1, 2), 2);
    assert.strictEqual(margin.parseFactor('abc', 2), 2);
    assert.strictEqual(margin.parseFactor(1000, 2), 2); // typo tipo `2000`
    assert.strictEqual(margin.parseFactor(1.5, 2), 1.5); // decimal válido sí pasa
    assert.strictEqual(margin.parseFactor('3', 2), 3);
});

// =============================================================================
// Parte 2 — Margen y alerta (CA-5 / CA-6)
// =============================================================================

test('margen sano — no dispara alerta', () => {
    // Escenario Gherkin implícito: el control del caso degradado.
    const r = margin.evaluateMargin({ peakMs: 100000, effectiveSeconds: 270, alertPct: 75 });
    assert.strictEqual(r.degraded, false);
    assert.strictEqual(r.consumedPct, 37);
});

test('margen degradado — pico 220s contra umbral 270s alerta con el dato numérico', () => {
    // Escenario Gherkin: "el margen se degrada y el operador se entera antes de
    // la caída". 220/270 = 81% consumido => por encima del 75% configurado.
    const r = margin.evaluateMargin({ peakMs: 220000, effectiveSeconds: 270, alertPct: 75 });
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(r.consumedPct, 81);
    assert.strictEqual(r.marginPct, 19);
    assert.strictEqual(r.peakSeconds, 220);
    assert.strictEqual(r.marginSeconds, 50);
});

test('margen — sin pico observable NO se inventa una degradación', () => {
    // La ausencia de datos nunca debe disfrazarse de alerta: sería ruido que
    // entrena al operador a ignorar el canal.
    for (const peak of [null, undefined, NaN, -1, 'x']) {
        const r = margin.evaluateMargin({ peakMs: peak, effectiveSeconds: 270 });
        assert.strictEqual(r.degraded, false, `peak=${String(peak)} no debería alertar`);
        assert.strictEqual(r.consumedPct, null);
    }
});

test('cooldown — la alerta es como máximo una por ventana (CA-6)', () => {
    const ahora = 1_000_000_000;
    const unaHora = 60 * 60 * 1000;

    assert.strictEqual(margin.shouldAlert(0, ahora, 60), true); // nunca se alertó
    assert.strictEqual(margin.shouldAlert(ahora - 1000, ahora, 60), false); // recién alertada
    assert.strictEqual(margin.shouldAlert(ahora - unaHora, ahora, 60), true); // venció
    // Estado corrupto (timestamp futuro) => callar, no spamear.
    assert.strictEqual(margin.shouldAlert(ahora + unaHora, ahora, 60), false);
});

// =============================================================================
// Parte 3 — Serie persistida (CA-1)
// =============================================================================

test('serie — la muestra se CLAMPEA al techo: contenido falsificado no vuela el umbral', () => {
    // `iterationMs` sale del contenido no confiable de last-tick.json (SEC-2).
    // Sin clamp, un valor absurdo empujaría el percentil sin límite.
    const s = margin.appendSample(margin.normalizeState({}), {
        now: 1000,
        durationMs: 999_999_999,
        maxEffectiveSeconds: 900,
    });
    assert.strictEqual(s.samples.length, 1);
    assert.strictEqual(s.samples[0].ms, 900 * 1000);
});

test('serie — respeta el cap de muestras descartando las más viejas', () => {
    let s = margin.normalizeState({});
    for (let i = 0; i < 15; i += 1) {
        s = margin.appendSample(s, { now: i, durationMs: i * 1000, maxSamples: 10 });
    }
    assert.strictEqual(s.samples.length, 10);
    assert.strictEqual(s.samples[0].ms, 5000); // las 5 primeras se podaron
});

test('serie — el MISMO ciclo muestreado varias veces aporta UNA sola muestra', () => {
    // El watchdog corre cada ~2 min y las iteraciones duran ~4: sin dedup, los
    // ciclos largos se contarían 2-3 veces y el percentil saldría sesgado hacia
    // arriba justo en la magnitud que se quiere medir.
    let s = margin.normalizeState({});
    for (let i = 0; i < 3; i += 1) {
        s = margin.appendSample(s, { now: i, durationMs: 240000, tickId: '2026-08-11T20:00:00.000Z' });
    }
    assert.strictEqual(s.samples.length, 1);

    // Una iteración nueva sí suma.
    s = margin.appendSample(s, { now: 9, durationMs: 250000, tickId: '2026-08-11T20:04:00.000Z' });
    assert.strictEqual(s.samples.length, 2);
});

test('serie — normalizar repetidamente NO borra muestras (regresión: t=0 se perdía sola)', () => {
    // `t` es metadata y no participa de ningún cálculo. Con un filtro `t > 0`,
    // una muestra observada en t=0 desaparecía en el siguiente normalizeState:
    // la serie perdía datos en silencio, que es el peor modo de falla posible
    // para algo cuyo trabajo es dimensionar un umbral.
    let s = margin.appendSample(margin.normalizeState({}), { now: 0, durationMs: 5000 });
    assert.strictEqual(s.samples.length, 1);
    for (let i = 0; i < 5; i += 1) s = margin.normalizeState(s);
    assert.strictEqual(s.samples.length, 1, 'la muestra se borró al re-normalizar');
});

test('serie — sin tickId se acepta la muestra (sesgo leve > no tener serie)', () => {
    let s = margin.normalizeState({});
    s = margin.appendSample(s, { now: 1, durationMs: 1000 });
    s = margin.appendSample(s, { now: 2, durationMs: 1000 });
    assert.strictEqual(s.samples.length, 2);
});

test('serie — una muestra ilegible se ignora en vez de contaminar la serie', () => {
    const base = margin.normalizeState({});
    for (const basura of [null, undefined, NaN, -1, 'abc']) {
        const s = margin.appendSample(base, { now: 1, durationMs: basura });
        assert.strictEqual(s.samples.length, 0, `durationMs=${String(basura)} no debería entrar`);
    }
});

test('serie — estado corrupto en disco degrada a vacío (umbral al piso), no explota', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5821-state-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{ esto no es json ');
    const s = margin.loadState(file);
    assert.deepStrictEqual(s.samples, []);
    assert.deepStrictEqual(s.kills, []);
});

test('serie — round-trip atómico conserva muestras y kills', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5821-state-'));
    const file = path.join(dir, 'sub', 'state.json'); // el dir no existe todavía
    let s = margin.appendSample(margin.normalizeState({}), { now: 10, durationMs: 5000 });
    s = margin.recordKill(s, 20, 60);
    margin.saveStateAtomic(file, s);
    const leido = margin.loadState(file);
    assert.strictEqual(leido.samples.length, 1);
    assert.strictEqual(leido.samples[0].ms, 5000);
    assert.deepStrictEqual(leido.kills, [20]);
});

// =============================================================================
// Parte 4 — Freno anti-bucle (CA-7)
// =============================================================================

test('racha de kills — bajo el cap se permite reiniciar', () => {
    const ahora = 1_000_000_000;
    const r = margin.decideKillStreak({ kills: [ahora - 1000, ahora - 2000], now: ahora, maxKills: 3 });
    assert.strictEqual(r.action, 'allow');
    assert.strictEqual(r.killsInWindow, 2);
});

test('racha de kills — alcanzado el cap se ESCALA en vez de repetirse (CA-7)', () => {
    // Escenario Gherkin: "una racha de reinicios escala en vez de repetirse".
    // En el incidente hubo 77 kills en 3 h: si matar 3 veces no arregló nada,
    // la 4ta tampoco lo va a hacer.
    const ahora = 1_000_000_000;
    const r = margin.decideKillStreak({
        kills: [ahora - 1000, ahora - 2000, ahora - 3000],
        now: ahora,
        maxKills: 3,
        windowMinutes: 60,
    });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.killsInWindow, 3);
});

test('racha de kills — los kills fuera de ventana no cuentan contra el cap', () => {
    const ahora = 1_000_000_000;
    const dosHoras = 2 * 60 * 60 * 1000;
    const r = margin.decideKillStreak({
        kills: [ahora - dosHoras, ahora - dosHoras - 1, ahora - dosHoras - 2],
        now: ahora,
        maxKills: 3,
        windowMinutes: 60,
    });
    assert.strictEqual(r.action, 'allow');
    assert.strictEqual(r.killsInWindow, 0);
});

// =============================================================================
// Parte 5 — Señal secundaria de progreso (CA-4)
// =============================================================================

const HECHOS_VENCIDOS = Object.freeze({
    hbExists: true,
    hbAgeMs: 300000, // 300s
    hbPidFromContent: 4242,
    soPid: 4242,
    killThresholdMs: 270000, // 270s => vencido
});

test('progreso — heartbeat vencido + progreso reciente => ciclo lento, NO se mata', () => {
    // Escenario Gherkin: "un ciclo lento no se confunde con un cuelgue".
    const r = liveness.decide({
        ...HECHOS_VENCIDOS,
        progressAgeMs: 3000,
        progressThresholdMs: 60000,
        maxSlowCycleMs: 900000,
    });
    assert.strictEqual(r, 'skip-slow-cycle');
});

test('progreso — heartbeat vencido y SIN progreso => cuelgue real, se mata', () => {
    const r = liveness.decide({
        ...HECHOS_VENCIDOS,
        progressAgeMs: 400000, // la señal también está vieja
        progressThresholdMs: 60000,
        maxSlowCycleMs: 900000,
    });
    assert.strictEqual(r, 'kill-respawn');
});

test('progreso — señal ausente o ilegible NUNCA inhibe el kill (INV-4)', () => {
    // Guardarraíl de seguridad: un `last-progress` borrado, con mtime raro o
    // simplemente inexistente (Pulpo viejo) no puede proteger a un zombi.
    for (const basura of [null, undefined, NaN, -1, 'abc', Infinity]) {
        const r = liveness.decide({
            ...HECHOS_VENCIDOS,
            progressAgeMs: basura,
            progressThresholdMs: 60000,
        });
        assert.strictEqual(r, 'kill-respawn', `progressAgeMs=${String(basura)} inhibió el kill`);
    }
});

test('progreso — el TECHO del ciclo lento mata igual a un proceso que "progresa" para siempre', () => {
    // Un retry loop que sigue tocando hitos eternamente reporta progreso y sigue colgado.
    const r = liveness.decide({
        ...HECHOS_VENCIDOS,
        hbAgeMs: 1_000_000, // ~16 min sin cerrar una iteración
        progressAgeMs: 1000, // "progresando"
        progressThresholdMs: 300000,
        maxSlowCycleMs: 900000, // 15 min
    });
    assert.strictEqual(r, 'kill-respawn');
});

test('progreso — el techo NUNCA puede quedar <= al umbral: la rama sería código muerto', () => {
    // Si `maxSlowCycleMs <= killThresholdMs` no existe ninguna edad que caiga en
    // la ventana (matar exige age > umbral, tolerar exige age <= techo), así que
    // el runner eleva el techo a 2× el umbral efectivo. Acá se comprueba que el
    // colapso es real si alguien lo configura mal, para que quede documentado
    // por qué el runner hace ese `Math.max`.
    const colapsado = liveness.decide({
        ...HECHOS_VENCIDOS,
        killThresholdMs: 900000,
        hbAgeMs: 950000,
        progressAgeMs: 1000,
        maxSlowCycleMs: 900000, // == umbral
    });
    assert.strictEqual(colapsado, 'kill-respawn', 'con techo == umbral la tolerancia desaparece');

    // Con el techo elevado como hace el runner (2× umbral), la ventana existe.
    const sano = liveness.decide({
        ...HECHOS_VENCIDOS,
        killThresholdMs: 900000,
        hbAgeMs: 950000,
        progressAgeMs: 1000,
        progressThresholdMs: 300000,
        maxSlowCycleMs: 1800000,
    });
    assert.strictEqual(sano, 'skip-slow-cycle');
});

test('progreso — con el heartbeat SANO la señal es irrelevante (no cambia el camino feliz)', () => {
    const r = liveness.decide({
        ...HECHOS_VENCIDOS,
        hbAgeMs: 10000,
        progressAgeMs: 999999,
    });
    assert.strictEqual(r, 'skip');
});

test('iterationMs — se parsea defensivo del contenido no confiable (SEC-2)', () => {
    assert.strictEqual(liveness.parseHeartbeatIterationMs('{"iterationMs":1234}'), 1234);
    assert.strictEqual(liveness.parseHeartbeatIterationMs('{"pid":1}'), null); // ausente
    assert.strictEqual(liveness.parseHeartbeatIterationMs('no json'), null);
    assert.strictEqual(liveness.parseHeartbeatIterationMs('{"iterationMs":"600"}'), null); // string
    assert.strictEqual(liveness.parseHeartbeatIterationMs('{"iterationMs":-1}'), null);
    assert.strictEqual(liveness.parseHeartbeatIterationMs(''), null);
});

// =============================================================================
// Parte 6 — Integración end-to-end del runner
// =============================================================================

const SHIMS = {
    'pulpo-liveness': path.join(REAL_LIB, 'pulpo-liveness.js'),
    'pulpo-liveness-margin': path.join(REAL_LIB, 'pulpo-liveness-margin.js'),
    // #6146: el copy al operador vive en su propio módulo. Sin este shim el
    // runner no lo encuentra en el tmpdir y el aviso se pierde en el fail-soft.
    'pulpo-liveness-copy': path.join(REAL_LIB, 'pulpo-liveness-copy.js'),
    'watchdog-supervisor': path.join(REAL_LIB, 'watchdog-supervisor.js'),
    'notify-telegram': path.join(REAL_LIB, 'notify-telegram.js'),
    'config-resolver': path.join(REAL_LIB, 'config-resolver.js'),
};

// Config con `min_samples` bajo para que los tests no necesiten 100 ciclos
// reales, y el resto en los valores de producción.
const CONFIG = [
    'watchdog:',
    '  pulpo_liveness_kill_seconds: 270',
    '  pulpo_liveness_percentile: 99',
    '  pulpo_liveness_percentile_factor: 2',
    '  pulpo_liveness_max_effective_seconds: 900',
    '  pulpo_liveness_min_samples: 10',
    '  pulpo_liveness_max_samples: 720',
    '  pulpo_liveness_alert_margin_pct: 75',
    '  pulpo_liveness_alert_cooldown_minutes: 60',
    '  pulpo_liveness_max_kills: 3',
    '  pulpo_liveness_kill_window_minutes: 60',
    '  pulpo_liveness_progress_stale_seconds: 300',
    '  pulpo_liveness_max_slow_cycle_seconds: 1800',
    '',
].join('\n');

function armarPipeline(configYaml = CONFIG) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5821-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.copyFileSync(path.join(PIPELINE_DIR, RUNNER), path.join(dir, RUNNER));
    fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml);
    seedProductManifest(dir);
    for (const [nombre, real] of Object.entries(SHIMS)) {
        fs.writeFileSync(
            path.join(dir, 'lib', `${nombre}.js`),
            `module.exports = require(${JSON.stringify(real)});\n`,
        );
    }
    return dir;
}

/** Siembra la serie de muestras que el runner va a leer. */
function sembrarEstado(dir, estado) {
    fs.writeFileSync(
        path.join(dir, 'logs', 'pulpo-liveness-state.json'),
        JSON.stringify(estado),
    );
}

function correr(dir, env) {
    const salida = execFileSync(process.execPath, [path.join(dir, RUNNER)], {
        env: {
            ...process.env,
            // El notifier resuelve su cola desde este override: sin él, los
            // tests encolarían mensajes de Telegram DE VERDAD.
            PIPELINE_DIR_OVERRIDE: dir,
            PLV_HB_EXISTS: '1',
            PLV_HB_CONTENT: '{"pid":4242,"timestamp":"2020-01-01T00:00:00.000Z"}',
            PLV_SO_PID: '4242',
            PLV_PROGRESS_AGE_MS: '',
            PULPO_LIVENESS_KILL_SECONDS: '',
            ...env,
        },
        encoding: 'utf8',
    }).trim();
    return salida;
}

/** Alertas encoladas por el runner (drops de lib/notify-telegram.js). */
function alertas(dir) {
    const cola = path.join(dir, 'servicios', 'telegram', 'pendiente');
    if (!fs.existsSync(cola)) return [];
    return fs
        .readdirSync(cola)
        .map((f) => JSON.parse(fs.readFileSync(path.join(cola, f), 'utf8')).text);
}

function logDelRunner(dir) {
    return fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness.log'), 'utf8');
}

/** 99 ciclos de 100s + 1 pico de `picoMs`: el pico no mueve el p99. */
function serieConPico(picoMs) {
    const samples = [];
    for (let i = 0; i < 99; i += 1) samples.push({ t: 1000 + i, ms: 100000 });
    samples.push({ t: 2000, ms: picoMs });
    return { samples, kills: [], lastAlertTs: 0, lastEscalationTs: 0, alertRepeats: 0 };
}

test('E2E — margen sano: no alerta y no reinicia', () => {
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(100000)); // pico == el resto: 37% consumido
    const out = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });

    assert.strictEqual(out, 'ACTION:skip');
    assert.deepStrictEqual(alertas(dir), []);
    // CA-4: la decisión registra el umbral efectivo y el margen, no sólo el literal.
    const l = logDelRunner(dir);
    assert.match(l, /effectiveSeconds=270/);
    assert.match(l, /consumedPct=37/);
});

test('E2E — margen degradado: alerta con el dato numérico y NO reinicia', () => {
    // Escenario Gherkin completo: umbral efectivo 270s, pico de ventana 220s
    // => alerta indicando que el margen quedó por debajo del 25%, sin reiniciar.
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(220000));
    const out = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });

    assert.strictEqual(out, 'ACTION:skip', 'la alerta debe llegar ANTES del primer kill');

    const msgs = alertas(dir);
    assert.strictEqual(msgs.length, 1, `esperaba 1 alerta, hubo ${msgs.length}`);
    const texto = msgs[0];
    // #6146 — el copy al operador cambió: antes acá viajaban el pico, el umbral,
    // el % consumido y la ruta del archivo de configuración. El operador dijo
    // textual que así no se entendía. Ahora el aviso es síntoma + consecuencia y
    // el detalle numérico vive en el log (se verifica abajo).
    assert.match(texto, /reiniciaría el Pulpo aunque esté trabajando bien/);
    // UX: nombrar el síntoma que el operador va a percibir — es lo que evita
    // 3 horas de diagnóstico en la dirección equivocada.
    assert.match(texto, /el Commander deja de responder/);
    // #6146 CA-5: pico 220s contra umbral 270s => quedan 50s, o sea nivel
    // "atención", no "inminente".
    assert.match(texto, /todavía hay aire: quedan 50 segundos de tolerancia/);
    // #6146 CA-2: el aviso ya NO filtra vocabulario interno ni rutas.
    assert.doesNotMatch(texto, /config\.yaml/);
    assert.doesNotMatch(texto, /umbral/i);
    assert.doesNotMatch(texto, /pulpo_liveness_/);
    // #6146 CA-7: todo el detalle técnico sigue disponible para diagnóstico.
    const log6146 = logDelRunner(dir);
    assert.match(log6146, /alerta_margen emitida urgencia=atencion/);
    assert.match(log6146, /repeticionesSilenciadas=0/);
    assert.match(log6146, /peakSeconds=220/);
    assert.match(log6146, /effectiveSeconds=270/);
    assert.match(log6146, /consumedPct=81/);
    assert.match(log6146, /marginSeconds=50/);
    // UX: ⚠️ = "el pipeline sigue", distinto del glifo de escalada.
    assert.match(texto, /⚠/);
});

test('E2E — la alerta NO se repite ciclo a ciclo: como máximo una por ventana (CA-6)', () => {
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(220000));

    for (let i = 0; i < 5; i += 1) {
        correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    }

    const msgs = alertas(dir);
    assert.strictEqual(
        msgs.length,
        1,
        `77 mensajes idénticos entrenan al operador a silenciar el canal; hubo ${msgs.length}`,
    );
});

test('E2E — cuelgue real sin señal de progreso: reinicia', () => {
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(100000));
    const out = correr(dir, {
        PLV_HB_AGE_MS: String(300 * 1000), // > 270s efectivos
        PLV_PROGRESS_AGE_MS: '', // sin señal secundaria
    });
    assert.strictEqual(out, 'ACTION:kill-respawn');
});

test('E2E — ciclo lento con progreso fresco: NO reinicia y lo deja registrado', () => {
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(100000));
    const out = correr(dir, {
        PLV_HB_AGE_MS: String(300 * 1000),
        PLV_PROGRESS_AGE_MS: '3000',
    });
    assert.strictEqual(out, 'ACTION:skip');
    const l = logDelRunner(dir);
    assert.match(l, /CICLO LENTO/);
    assert.match(l, /decision=skip-slow-cycle/);
    assert.match(l, /effectiveSeconds=270/); // CA-4 también en este camino
});

test('E2E — racha de reinicios alcanzada: escala a needs-human en vez de reiniciar', () => {
    const dir = armarPipeline();
    const ahora = Date.now();
    const estado = serieConPico(100000);
    estado.kills = [ahora - 1000, ahora - 2000, ahora - 3000]; // cap = 3
    sembrarEstado(dir, estado);

    const out = correr(dir, { PLV_HB_AGE_MS: String(300 * 1000) });
    assert.strictEqual(out, 'ACTION:escalate');

    const msgs = alertas(dir);
    assert.strictEqual(msgs.length, 1);
    assert.match(msgs[0], /needs-human/);
    assert.match(msgs[0], /3 veces/);
    // UX: glifo de "algo quedó frenado", distinto del ⚠️ del margen degradado.
    assert.match(msgs[0], /\u{1F6A8}/u);
});

test('E2E — el ciclo que termina en kill NO entra a la serie de calibración', () => {
    // Si entrara, cada cuelgue subiría el p99 y con él el umbral: el watchdog se
    // volvería progresivamente ciego, en silencio y sin ningún kill que lo delate.
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(100000));
    correr(dir, {
        PLV_HB_AGE_MS: String(300 * 1000),
        PLV_HB_CONTENT: '{"pid":4242,"timestamp":"2020-01-01T00:00:00.000Z","iterationMs":800000}',
    });

    const estado = JSON.parse(
        fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness-state.json'), 'utf8'),
    );
    assert.strictEqual(estado.samples.length, 100, 'la muestra del cuelgue no debe entrar');
    assert.ok(
        estado.samples.every((s) => s.ms <= 100000),
        'ninguna muestra debería venir del ciclo que terminó en kill',
    );
    // #5821 (rebote rev-1) — Este assert decía `kills.length === 1`, o sea daba
    // por bueno contabilizar el kill en el ciclo de DECISIÓN. Eso contaba
    // intentos y no terminaciones: con `Stop-Process` fallando, el cap se
    // agotaba contra un Pulpo vivo y el watchdog dejaba de intentar matarlo. El
    // conteo se movió a `confirmKill()` (ver Parte 7).
    assert.deepStrictEqual(estado.kills, [], 'el intento todavía no es una terminación');
});

test('E2E — un ciclo sano SÍ agrega su iterationMs a la serie (CA-1)', () => {
    const dir = armarPipeline();
    sembrarEstado(dir, serieConPico(100000));
    correr(dir, {
        PLV_HB_AGE_MS: String(30 * 1000),
        PLV_HB_CONTENT: '{"pid":4242,"timestamp":"2020-01-01T00:00:00.000Z","iterationMs":123000}',
    });

    const estado = JSON.parse(
        fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness-state.json'), 'utf8'),
    );
    assert.strictEqual(estado.samples.length, 101);
    assert.strictEqual(estado.samples[estado.samples.length - 1].ms, 123000);
});

test('E2E — sin iterationMs no se acumula serie: el umbral se queda en el piso', () => {
    // `hbAgeMs` NO se usa como sustituto: es una muestra sesgada hacia abajo de
    // la duración y mezclarla deflactaría el percentil.
    const dir = armarPipeline();
    correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });

    const estado = JSON.parse(
        fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness-state.json'), 'utf8'),
    );
    assert.deepStrictEqual(estado.samples, []);
    assert.match(logDelRunner(dir), /effectiveSeconds=270/);
    assert.match(logDelRunner(dir), /thresholdSource=floor-insufficient-samples/);
});

test('E2E — un typo en una clave nueva de config se loguea, no degrada en silencio', () => {
    // La sección `watchdog:` es lenient en el schema: ajv no ataja el typo.
    const dir = armarPipeline(
        'watchdog:\n  pulpo_liveness_kill_seconds: 270\n  pulpo_liveness_min_samples: "diez"\n',
    );
    correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    assert.match(logDelRunner(dir), /DEGRADACION: watchdog\.pulpo_liveness_min_samples/);
});

// =============================================================================
// Parte 7 — Regresiones del rebote rev-1 (hallazgos de la revisión adversarial)
//
// Los dos primeros son la MISMA clase de defecto: el freno anti-bucle, que
// existe para proteger al pipeline, podía volverse el que lo deja sin
// recuperación automática. Ambos caminos terminan en un Pulpo colgado que el
// watchdog deja de intentar matar.
// =============================================================================

test('cap — un kill con timestamp FUTURO no cuenta contra el cap (reloj corrido)', () => {
    // `now - t < win` es verdadero para TODO t futuro: sin el descarte, 3 kills
    // adelantados dejaban toda decisión en `escalate` hasta que el tiempo real
    // los alcanzara, y el watchdog no volvía a matar un zombi en ese lapso.
    const now = 1_000_000_000_000;
    const futuros = [now + 12 * 3600 * 1000, now + 12 * 3600 * 1000, now + 12 * 3600 * 1000];

    const d = margin.decideKillStreak({ now, kills: futuros, maxKills: 3, windowMinutes: 60 });
    assert.strictEqual(d.action, 'allow', 'los kills futuros NO deben agotar el cap');
    assert.strictEqual(d.killsInWindow, 0);
});

test('cap — recordKill poda los timestamps futuros en vez de acumularlos', () => {
    const now = 1_000_000_000_000;
    const st = { kills: [now + 3600 * 1000, now - 1000], samples: [] };
    const next = margin.recordKill(st, now, 60);
    // Queda el kill pasado dentro de ventana + el nuevo. El futuro se descarta.
    assert.strictEqual(next.kills.length, 2);
    assert.ok(next.kills.every((t) => t <= now), 'no debe persistirse ningún kill futuro');
});

test('cap — la simetría con shouldAlert: ninguno de los dos confía en un ts futuro', () => {
    const now = 1_000_000_000_000;
    // shouldAlert ya protegía este caso; el cap ahora también.
    assert.strictEqual(margin.shouldAlert(now + 3600 * 1000, now, 60), false);
    assert.strictEqual(
        margin.decideKillStreak({ now, kills: [now + 3600 * 1000], maxKills: 1, windowMinutes: 60 })
            .action,
        'allow',
    );
});

test('cap — el ciclo de decisión NO contabiliza el kill (se cuenta al confirmarlo)', () => {
    // Antes se hacía recordKill en el ciclo de decisión, o sea ANTES de que
    // PowerShell intentara el Stop-Process. Con `Stop-Process` fallando (Acceso
    // denegado, recurrente en este host) el cap se agotaba contra un Pulpo vivo.
    const dir = armarPipeline();
    const salida = correr(dir, { PLV_HB_AGE_MS: String(600 * 1000) });
    assert.strictEqual(salida.split('\n').pop().trim(), 'ACTION:kill-respawn');

    const estado = JSON.parse(
        fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness-state.json'), 'utf8'),
    );
    assert.deepStrictEqual(estado.kills, [], 'el intento no debe contarse: todavía no mató nada');
});

test('cap — el modo confirmación SÍ contabiliza el kill que el SO confirmó', () => {
    const dir = armarPipeline();
    correr(dir, { PLV_HB_AGE_MS: String(600 * 1000), PLV_CONFIRM_KILL: '1' });

    const estado = JSON.parse(
        fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness-state.json'), 'utf8'),
    );
    assert.strictEqual(estado.kills.length, 1, 'el kill confirmado sí consume cap');
});

test('cap — N kills fallidos NO escalan: el watchdog sigue intentando matar al zombi', () => {
    // La regresión de disponibilidad completa: 3 ciclos con Stop-Process fallando
    // (o sea, 3 decisiones sin confirmación) deben seguir devolviendo
    // kill-respawn, no `escalate`.
    const dir = armarPipeline();
    for (let i = 0; i < 3; i++) {
        correr(dir, { PLV_HB_AGE_MS: String(600 * 1000) });
    }
    const salida = correr(dir, { PLV_HB_AGE_MS: String(600 * 1000) });
    assert.strictEqual(
        salida.split('\n').pop().trim(),
        'ACTION:kill-respawn',
        'sin terminaciones confirmadas el cap no se agota y se sigue intentando',
    );
});

test('cap — en cambio 3 kills CONFIRMADOS sí escalan (el freno real sigue vivo)', () => {
    const dir = armarPipeline();
    for (let i = 0; i < 3; i++) {
        correr(dir, { PLV_HB_AGE_MS: String(600 * 1000), PLV_CONFIRM_KILL: '1' });
    }
    const salida = correr(dir, { PLV_HB_AGE_MS: String(600 * 1000) });
    assert.strictEqual(salida.split('\n').pop().trim(), 'ACTION:escalate');
});

test('estado — el tmp de escritura es por-proceso (dos runners no se pisan)', () => {
    // Con un tmp de path fijo, dos runners solapados se corrompen el estado; el
    // fail-soft lo degrada a vacío y el umbral vuelve al piso marginal de 270s.
    const dir = armarPipeline();
    const file = path.join(dir, 'logs', 'estado-tmp.json');
    margin.saveStateAtomic(file, { samples: [{ t: 1, ms: 5 }], kills: [] });

    assert.ok(fs.existsSync(file));
    const sobrantes = fs
        .readdirSync(path.join(dir, 'logs'))
        .filter((f) => f.startsWith('estado-tmp.json.') && f.endsWith('.tmp'));
    assert.deepStrictEqual(sobrantes, [], 'el tmp no debe quedar tirado tras el rename');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).samples, [{ t: 1, ms: 5 }]);
});

// ---------------------------------------------------------------------------
// Parte 8 — #6146: la línea de persistencia sólo sale cuando hay evidencia
//
// `review` bloqueó la pasada anterior porque el aviso le afirmaba al operador un
// hecho falso: "ya te avisé hace 3 días y sigue pasando" para una condición que
// había aparecido en ese mismo ciclo. La causa era pasar `lastAlertTs` crudo al
// módulo de copy — esa marca dice CUÁNDO se avisó, no DESDE CUÁNDO sigue
// pasando, y nadie la reseteaba al recuperarse la condición.
//
// El arreglo son dos mitades que sólo funcionan juntas: el gate de persistencia
// (no pasar la marca si no hubo repeticiones) y la rama de recuperación (limpiar
// la evidencia cuando el margen vuelve a estar sano). Estos casos son el testigo
// end-to-end de esa pareja: cada mitad sola deja uno de ellos en rojo.
// ---------------------------------------------------------------------------

/** Estado que el runner dejó escrito en disco. */
function estadoEnDisco(dir) {
    return JSON.parse(
        fs.readFileSync(path.join(dir, 'logs', 'pulpo-liveness-state.json'), 'utf8'),
    );
}

const NOVENTA_MIN_MS = 90 * 60 * 1000;

test('E2E #6146 CA-6a+CA-6b — recuperarse borra la evidencia: el episodio nuevo no dice "ya te avisé"', () => {
    const dir = armarPipeline();
    const hace90min = Date.now() - NOVENTA_MIN_MS;

    // Episodio VIEJO ya cerrado: se avisó hace 90 min y hubo 3 ciclos degradados
    // silenciados por el cooldown. La serie de ahora está sana (pico 100s contra
    // 270s efectivos), o sea la condición se recuperó.
    const sano = serieConPico(100000);
    sano.lastAlertTs = hace90min;
    sano.alertRepeats = 3;
    sembrarEstado(dir, sano);

    const out = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    assert.strictEqual(out, 'ACTION:skip', 'CA-13: la decisión del watchdog no cambia');
    assert.deepStrictEqual(alertas(dir), [], 'un margen sano no le avisa nada al operador');

    const trasRecuperar = estadoEnDisco(dir);
    assert.strictEqual(
        trasRecuperar.alertRepeats,
        0,
        'CA-6b: la evidencia de persistencia caduca cuando la condición se recupera',
    );
    assert.strictEqual(
        trasRecuperar.lastAlertTs,
        hace90min,
        'la cadencia NO se resetea: pisar lastAlertTs haría alertar en cada oscilación',
    );

    // Episodio NUEVO: vuelve a degradarse con el cooldown ya vencido. Como la
    // evidencia se limpió, el aviso NO puede afirmar que ya se había avisado.
    const degradado = serieConPico(220000);
    degradado.lastAlertTs = trasRecuperar.lastAlertTs;
    degradado.alertRepeats = trasRecuperar.alertRepeats;
    sembrarEstado(dir, degradado);

    const out2 = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    assert.strictEqual(out2, 'ACTION:skip');

    const msgs = alertas(dir);
    assert.strictEqual(msgs.length, 1, `esperaba 1 aviso, hubo ${msgs.length}`);
    assert.doesNotMatch(
        msgs[0],
        /ya te avisé/,
        'CA-6a: sin repeticiones en la ventana no hay evidencia, así que la línea se omite',
    );
    assert.match(msgs[0], /reiniciaría el Pulpo aunque esté trabajando bien/);

    // CA-7: el log conserva por qué se omitió; si no, un aviso sin la línea es
    // indistinguible de un bug del módulo de copy.
    const l = logDelRunner(dir);
    assert.match(l, /prevAlertTsEnviado=omitido/);
    assert.match(l, /repeticionesSilenciadas=0/);
});

test('E2E #6146 CA-6b — una laguna de datos NO es una recuperación: la evidencia sobrevive', () => {
    const dir = armarPipeline();
    const hace90min = Date.now() - NOVENTA_MIN_MS;

    // Sin muestras no hay pico observable, y `evaluateMargin` devuelve
    // `degraded: false` igual que en un margen sano. Si la rama de recuperación
    // no distinguiera los dos casos, este hueco borraría la evidencia de un
    // episodio que sigue vivo.
    sembrarEstado(dir, {
        samples: [],
        kills: [],
        lastAlertTs: hace90min,
        lastEscalationTs: 0,
        alertRepeats: 3,
    });

    const out = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    assert.strictEqual(out, 'ACTION:skip');
    assert.deepStrictEqual(alertas(dir), []);
    assert.strictEqual(
        estadoEnDisco(dir).alertRepeats,
        3,
        'sin pico medido no se puede afirmar que la condición se recuperó',
    );
});

test('E2E #6146 — episodio realmente persistente: la frase sale, sin exponer el contador', () => {
    const dir = armarPipeline();

    const degradado = serieConPico(220000);
    degradado.lastAlertTs = Date.now() - NOVENTA_MIN_MS; // cooldown de 60 min vencido
    degradado.alertRepeats = 3; // hubo ciclos degradados dentro de la ventana
    sembrarEstado(dir, degradado);

    const out = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    assert.strictEqual(out, 'ACTION:skip');

    const msgs = alertas(dir);
    assert.strictEqual(msgs.length, 1);
    // 90 min => "hace una hora" (CA-11: singular, no "hace 1 horas").
    assert.match(msgs[0], /ya te avisé hace una hora y sigue pasando/);
    // CA-6: el operador nunca ve el contador interno que respalda la frase.
    assert.doesNotMatch(msgs[0], /repeticion/i);
    assert.doesNotMatch(msgs[0], /alertRepeats/);
    assert.doesNotMatch(msgs[0], /silenciad/i);
    // CA-2: la frase nueva tampoco filtra jerga ni rutas.
    assert.doesNotMatch(msgs[0], /config\.yaml/);
    assert.doesNotMatch(msgs[0], /umbral/i);
    assert.doesNotMatch(msgs[0], /percentil/i);

    // CA-7: el detalle sí queda en el log, incluido que la marca se dejó pasar.
    const l = logDelRunner(dir);
    assert.match(l, /repeticionesSilenciadas=3/);
    assert.match(l, /prevAlertTsEnviado=\d+/);
});

test('E2E #6146 CA-12 — si el copy no carga, el operador igual recibe UN aviso (no silencio)', () => {
    const dir = armarPipeline();
    // Shim roto: simula el módulo de copy inutilizable. El mensaje de error trae
    // una ruta absoluta a propósito, para verificar que no se filtra al canal.
    fs.writeFileSync(
        path.join(dir, 'lib', 'pulpo-liveness-copy.js'),
        'throw new Error("boom en /c/Workspaces/Intrale/platform/.pipeline/lib/roto.js");\n',
    );
    sembrarEstado(dir, serieConPico(220000));

    const out = correr(dir, { PLV_HB_AGE_MS: String(120 * 1000) });
    assert.strictEqual(out, 'ACTION:skip', 'CA-13: un fallo de copy no cambia la decisión');

    const msgs = alertas(dir);
    assert.strictEqual(
        msgs.length,
        1,
        `el aviso degradado sale una sola vez (ni silencio ni duplicado); hubo ${msgs.length}`,
    );
    const texto = msgs[0];
    assert.match(texto, /El vigilante puede reiniciar el Pulpo aunque está trabajando bien/);
    assert.match(texto, /el Commander deja de responder/);
    // CA-9: sigue siendo `warn` (⚠️), no se degrada ni se escala de severidad.
    assert.match(texto, /⚠/);
    assert.doesNotMatch(texto, /\u{1F6A8}/u);
    // SEC-6: el texto de rescate es constante — ni el error ni las rutas viajan.
    assert.doesNotMatch(texto, /boom/);
    assert.doesNotMatch(texto, /\.pipeline/);
    assert.doesNotMatch(texto, /roto\.js/);
    assert.doesNotMatch(texto, /Workspaces/);

    // CA-7: el detalle del fallo queda en el log, que es donde se diagnostica.
    const l = logDelRunner(dir);
    assert.match(l, /copy de la alerta de margen no disponible/);
    assert.match(l, /alerta_margen emitida urgencia=desconocida/);
});
