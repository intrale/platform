// =============================================================================
// dashboard-config-invalida-viva.test.js — #5172 · CA-8
//
// REGRESIÓN de la muerte del dashboard con `config.yaml` inválido.
//
// El fail-closed de #5172 hace que `_genPipelineState()` corte temprano y
// devuelva un estado degradado (`config: null` + `configError`) en vez del
// snapshot completo. `generateHTML` asume el snapshot completo, así que la
// primera línea que tocaba `Object.entries(state.issueMatrix)` tiraba
// `TypeError` → `uncaughtException` → `process.exit(1)`.
//
// Lo grave era el disparador: el handler legacy es el CATCH-ALL de las URLs no
// matcheadas, y `/favicon.ico` — que pide todo navegador al abrir el tablero —
// caía ahí. O sea: abrir el dashboard lo mataba, y el operador perdía la única
// pantalla que le habría dicho que el pipeline estaba pausado por config rota.
//
// Este test levanta el dashboard REAL como proceso hijo contra un config roto y
// verifica el contrato completo: sirve la pantalla de error, y sigue VIVO.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { seedProductManifest, seedRealProductManifest } = require('./_test-helpers');

const DASHBOARD = path.resolve(__dirname, '..', '..', 'dashboard.js');
// Puerto alto derivado del pid para no chocar con el dashboard real (3200) ni
// con otra corrida en paralelo.
const PORT = 21000 + (process.pid % 3000);
const BOOT_TIMEOUT_MS = 60000;

function get(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 15000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
    });
}

async function esperarListen(child) {
    const hasta = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < hasta) {
        if (child.exitCode !== null) throw new Error(`el dashboard murió durante el boot (exit ${child.exitCode})`);
        try {
            const r = await get('/api/health');
            if (r.status === 200) return;
        } catch { /* todavía no bindeó */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('el dashboard no llegó a escuchar dentro del timeout');
}

test('#5172 CA-8: con config.yaml inválido el dashboard sirve la pantalla de error y NO muere', async (t) => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-dash-cfg-'));
    const PIPE = path.join(TMP, '.pipeline');
    fs.mkdirSync(path.join(PIPE, 'logs'), { recursive: true });
    // YAML que no parsea (mismo shape que un archivo a medio escribir).
    fs.writeFileSync(path.join(PIPE, 'config.yaml'), 'pipelines: [[[\n  roto: : :\n', 'utf8');
    seedProductManifest(PIPE);   // #5174 — la configuración vive partida: el otro lado también

    const child = spawn(process.execPath, [DASHBOARD], {
        env: {
            ...process.env,
            DASHBOARD_PORT: String(PORT),
            PIPELINE_STATE_DIR: PIPE,
            PIPELINE_MAIN_ROOT: TMP,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    child.stdout.on('data', (d) => { salida += d; });
    child.stderr.on('data', (d) => { salida += d; });

    t.after(() => {
        try { child.kill('SIGKILL'); } catch {}
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    });

    await esperarListen(child);

    // 1) El disparador exacto del bug: la URL no matcheada que pide el navegador.
    const favicon = await get('/favicon.ico');
    assert.equal(favicon.status, 503, 'config inválida ⇒ 503, no un tablero vacío ni un crash');
    assert.match(favicon.body, /Configuración inválida/,
        'la pantalla tiene que DECIR que la config está rota (si no, el operador no se entera)');

    // 2) La raíz del tablero: mismo contrato.
    const raiz = await get('/');
    assert.equal(raiz.status, 503);
    assert.match(raiz.body, /Configuración inválida/);
    assert.match(raiz.body, /Acción/, 'la pantalla trae la acción correctiva (CA-UX-5)');

    // 3) SEC-1: el error no vuelca el contenido crudo del archivo.
    assert.doesNotMatch(raiz.body, /roto: : :/, 'no se filtra el valor crudo que falló');

    // 4) EL punto de la historia: el proceso SIGUE VIVO después de todo eso.
    assert.equal(child.exitCode, null, 'el dashboard NO puede morir por una config inválida');
    assert.doesNotMatch(salida, /uncaughtException/, 'ninguna ruta escaló a uncaughtException');

    // 5) Y sigue respondiendo el readiness que usa el smoke del restart.
    const health = await get('/api/health');
    assert.equal(health.status, 200);
});

test('#5172 CA-8: con config.yaml válido el tablero se sirve normal (no hay falso 503)', async (t) => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-dash-ok-'));
    const PIPE = path.join(TMP, '.pipeline');
    fs.mkdirSync(path.join(PIPE, 'logs'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '..', '..', 'config.yaml'), path.join(PIPE, 'config.yaml'));
    seedRealProductManifest(PIPE);   // #5174 — fixture copiado del config.yaml real ⇒ manifiesto real

    const port = PORT + 1;
    const child = spawn(process.execPath, [DASHBOARD], {
        env: {
            ...process.env,
            DASHBOARD_PORT: String(port),
            PIPELINE_STATE_DIR: PIPE,
            PIPELINE_MAIN_ROOT: TMP,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    child.stdout.on('data', (d) => { salida += d; });
    child.stderr.on('data', (d) => { salida += d; });

    t.after(() => {
        try { child.kill('SIGKILL'); } catch {}
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    });

    const getEn = (pathname) => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 20000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
    });

    const hasta = Date.now() + BOOT_TIMEOUT_MS;
    let listo = false;
    while (Date.now() < hasta && !listo) {
        if (child.exitCode !== null) throw new Error(`murió en el boot (exit ${child.exitCode})`);
        try { listo = (await getEn('/api/health')).status === 200; } catch {}
        if (!listo) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(listo, 'el dashboard tiene que arrancar con config válida');

    const raiz = await getEn('/');
    assert.equal(raiz.status, 200, 'config válida ⇒ tablero normal');
    assert.doesNotMatch(raiz.body, /Configuración inválida/);
    assert.equal(child.exitCode, null);
});
