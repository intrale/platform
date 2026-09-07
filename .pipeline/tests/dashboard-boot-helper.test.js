// =============================================================================
// dashboard-boot-helper.test.js — Contrato del helper de arranque (#5796)
// =============================================================================
//
// El helper existe para separar dos modos de fallo que antes se veían iguales:
// "la máquina está cargada y el dashboard todavía está levantando" vs "el
// dashboard murió y nunca va a escuchar". Estos tests fijan esa separación, que
// es lo único que permite subir el presupuesto de espera sin volver lento el
// diagnóstico de un arranque roto.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    spawnDashboard,
    waitForDashboardBoot,
    resolveBootTimeoutMs,
    DEFAULT_BOOT_TIMEOUT_MS,
} = require('./helpers/dashboard-boot');

const TMP_DIRS = [];

/** Script hijo descartable, en su propio directorio (aislado cross-proceso). */
function writeChildScript(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-helper-'));
    TMP_DIRS.push(dir);
    const file = path.join(dir, 'child.js');
    fs.writeFileSync(file, body, 'utf8');
    return file;
}

process.on('exit', () => {
    for (const dir of TMP_DIRS) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
});

// -----------------------------------------------------------------------------
test('resolveBootTimeoutMs: default 75s, override explícito y por env', () => {
    const previo = process.env.DASHBOARD_BOOT_TIMEOUT_MS;
    try {
        delete process.env.DASHBOARD_BOOT_TIMEOUT_MS;
        assert.equal(resolveBootTimeoutMs(), DEFAULT_BOOT_TIMEOUT_MS);
        assert.equal(DEFAULT_BOOT_TIMEOUT_MS, 75 * 1000);

        process.env.DASHBOARD_BOOT_TIMEOUT_MS = '1234';
        assert.equal(resolveBootTimeoutMs(), 1234);

        // El valor explícito del caller gana sobre el env.
        assert.equal(resolveBootTimeoutMs(999), 999);

        // Basura en el env NO puede dejar el presupuesto en 0 (fail-open al default).
        process.env.DASHBOARD_BOOT_TIMEOUT_MS = 'no-es-un-numero';
        assert.equal(resolveBootTimeoutMs(), DEFAULT_BOOT_TIMEOUT_MS);
        process.env.DASHBOARD_BOOT_TIMEOUT_MS = '0';
        assert.equal(resolveBootTimeoutMs(), DEFAULT_BOOT_TIMEOUT_MS);
        process.env.DASHBOARD_BOOT_TIMEOUT_MS = '-5';
        assert.equal(resolveBootTimeoutMs(), DEFAULT_BOOT_TIMEOUT_MS);
    } finally {
        if (previo === undefined) delete process.env.DASHBOARD_BOOT_TIMEOUT_MS;
        else process.env.DASHBOARD_BOOT_TIMEOUT_MS = previo;
    }
});

// -----------------------------------------------------------------------------
test('devuelve el valor del probe apenas está listo (sin agotar el presupuesto)', async () => {
    const script = writeChildScript('setTimeout(() => {}, 60000);');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    try {
        let intentos = 0;
        const t0 = Date.now();
        const valor = await waitForDashboardBoot({
            child,
            // Listo recién en el tercer sondeo: modela el arranque lento.
            probe: () => (++intentos >= 3 ? 'el-body-del-dashboard' : null),
            intervalMs: 20,
            firstDelayMs: 5,
            timeoutMs: 10000,
        });
        assert.equal(valor, 'el-body-del-dashboard', 'debe devolver lo que resolvió el probe');
        assert.equal(intentos, 3);
        assert.ok(Date.now() - t0 < 5000, 'no debe esperar el presupuesto completo');
    } finally {
        child.kill();
    }
});

// -----------------------------------------------------------------------------
test('un probe que rechaza cuenta como "todavía no" y se reintenta', async () => {
    const script = writeChildScript('setTimeout(() => {}, 60000);');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    try {
        let intentos = 0;
        const valor = await waitForDashboardBoot({
            child,
            probe: () => {
                if (++intentos < 3) {
                    const e = new Error('connect ECONNREFUSED 127.0.0.1:1');
                    return Promise.reject(e);
                }
                return Promise.resolve(true);
            },
            intervalMs: 20,
            firstDelayMs: 5,
            timeoutMs: 10000,
        });
        assert.equal(valor, true);
        assert.equal(intentos, 3);
    } finally {
        child.kill();
    }
});

// -----------------------------------------------------------------------------
test('FAIL-FAST — si el hijo muere rechaza en el acto, sin esperar el presupuesto', async () => {
    // Un dashboard que explota al arrancar (config inválido, require roto).
    const script = writeChildScript('console.error("boom: config inválido");\nprocess.exit(3);\n');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    const t0 = Date.now();
    await assert.rejects(
        () => waitForDashboardBoot({
            child,
            probe: () => false,                 // nunca va a estar listo
            timeoutMs: 60000,                   // presupuesto largo a propósito
            intervalMs: 50,
            firstDelayMs: 10,
        }),
        (err) => {
            assert.match(err.message, /murió durante el arranque/);
            assert.match(err.message, /code=3/);
            // El motivo REAL viaja en el mensaje: es la diferencia con el
            // ECONNREFUSED genérico que devolvía el bucle copiado.
            assert.match(err.message, /boom: config inválido/);
            return true;
        },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 15000, `debía fallar rápido, tardó ${elapsed}ms`);
});

// -----------------------------------------------------------------------------
test('agotar el presupuesto reporta el último motivo del sondeo', async () => {
    const script = writeChildScript('setTimeout(() => {}, 60000);');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    try {
        await assert.rejects(
            () => waitForDashboardBoot({
                child,
                probe: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:65000')),
                timeoutMs: 400,
                intervalMs: 50,
                firstDelayMs: 10,
                label: 'dashboard-de-prueba',
            }),
            (err) => {
                assert.match(err.message, /dashboard-de-prueba no levantó tras/);
                assert.match(err.message, /ECONNREFUSED/);
                return true;
            },
        );
    } finally {
        child.kill();
    }
});

// -----------------------------------------------------------------------------
test('un probe que TIRA sincrónicamente no tumba la espera', async () => {
    const script = writeChildScript('setTimeout(() => {}, 60000);');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    try {
        let intentos = 0;
        const valor = await waitForDashboardBoot({
            child,
            probe: () => {
                if (++intentos < 2) throw new Error('explota sincrónico');
                return true;
            },
            intervalMs: 20,
            firstDelayMs: 5,
            timeoutMs: 10000,
        });
        assert.equal(valor, true);
    } finally {
        child.kill();
    }
});

// -----------------------------------------------------------------------------
// Regresión directa del rebote de #5796: los before hooks no morían con
// "el dashboard no levantó", morían con `test timed out after 120000ms`. Ese es
// el síntoma de un probe que queda pendiente para siempre (un `http.get` con
// `timeout:` en las options pero sin handler `'timeout'`): el bucle sólo mira el
// deadline al agendar el próximo tick, y sin respuesta del probe nunca lo agenda.
test('WATCHDOG — un probe que nunca settlea igual respeta el presupuesto', async () => {
    const script = writeChildScript('setTimeout(() => {}, 60000);');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    try {
        const t0 = Date.now();
        await assert.rejects(
            () => waitForDashboardBoot({
                child,
                probe: () => new Promise(() => { /* jamás resuelve ni rechaza */ }),
                timeoutMs: 500,
                intervalMs: 50,
                firstDelayMs: 10,
                label: 'dashboard-colgado',
            }),
            (err) => {
                assert.match(err.message, /dashboard-colgado no levantó tras/);
                assert.match(err.message, /sondeo sin respuesta/);
                return true;
            },
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 5000, `debía cortar por presupuesto, tardó ${elapsed}ms`);
    } finally {
        child.kill();
    }
});

// -----------------------------------------------------------------------------
test('WATCHDOG — el hijo muerto sigue ganándole al watchdog (fail-fast intacto)', async () => {
    const script = writeChildScript('console.error("muere temprano");\nprocess.exit(9);\n');
    const child = spawnDashboard({ dashboardPath: script, env: process.env });
    await assert.rejects(
        () => waitForDashboardBoot({
            child,
            probe: () => new Promise(() => { /* colgado */ }),
            timeoutMs: 30000,
            intervalMs: 50,
            firstDelayMs: 10,
        }),
        // Gana el diagnóstico útil, no el genérico del presupuesto.
        /murió durante el arranque \(code=9/,
    );
});

// -----------------------------------------------------------------------------
test('sin probe rechaza en vez de colgarse', async () => {
    await assert.rejects(
        () => waitForDashboardBoot({ child: null }),
        /requiere un probe/,
    );
});
