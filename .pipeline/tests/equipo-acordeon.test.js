'use strict';

// =============================================================================
// Tests EP8-H2 (#3955) — Equipo → acordeón por skill con agentes individuales.
//
// Cubre:
//   - renderTeamAccordion (SSR): agrupa por skill, fila por agente con issue/
//     fase/progreso%/duración/log; Commander visible SIN kill (CA-1/CA-3);
//     cooldown con countdown (CA-4); sparkline 24h (CA-5).
//   - Escape XSS del título de issue en el acordeón (SEC-5).
//   - Hardening del handler /api/kill-agent: validación de inputs (SEC-1),
//     guard commander 403 (SEC-3), CSRF 403 (SEC-2) — verificado por estructura
//     del source + por el módulo lib/kill-agent-csrf.
//   - cooldownFor / skillSpark24h (CA-4/CA-5/SEC-6) — slices.
//   - Redacción de secrets en logs (SEC-4) — handoff.sanitize aplicado.
//
// Ejecutar: node --test .pipeline/tests/equipo-acordeon.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const equipo = require('../views/dashboard/equipo.js');
const slices = require('../lib/dashboard-slices.js');
const killCsrf = require('../lib/kill-agent-csrf.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleState(extra) {
    return Object.assign({
        agentPersona: {
            'android-dev': { icon: '📱', name: 'Android Dev', color: '#58a6ff' },
            commander: { icon: '🎖', name: 'Commander', color: '#f778ba' },
        },
        teamSpark: { 'android-dev': [0, 1, 0, 2, 0, 0, 1, 0, 0, 3, 0, 0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 1, 0, 4] },
        teamAgents: [
            {
                issue: '3964', skill: 'android-dev', pipeline: 'desarrollo', fase: 'dev',
                title: 'Pantalla de login', durationMs: 492000, etaMs: 600000,
                hasLog: true, logFile: 'agent-3964.log', cancelable: true, observational: false, cooldown: null,
            },
            {
                issue: '3970', skill: 'android-dev', pipeline: 'desarrollo', fase: 'dev',
                title: 'Otra pantalla', durationMs: 60000, etaMs: null,
                hasLog: false, cancelable: true, observational: false,
                cooldown: { failures: 2, cooldownUntil: new Date(Date.now() + 120000).toISOString() },
            },
            {
                issue: null, skill: 'commander', pipeline: null, fase: 'pensando',
                title: 'Commander', durationMs: 5000, etaMs: null, observational: true, cancelable: false,
            },
        ],
    }, extra || {});
}

// ---------------------------------------------------------------------------
// CA-1 — acordeón agrupa por skill + fila por agente
// ---------------------------------------------------------------------------

test('renderTeamAccordion agrupa por skill y cuenta agentes vivos (CA-1)', () => {
    const html = equipo.renderTeamAccordion(sampleState());
    assert.match(html, /data-skill="android-dev"/);
    assert.match(html, /data-skill="commander"/);
    // android-dev tiene 2 agentes → "2 vivos"
    assert.match(html, /2 vivos/);
    // commander 1 → "1 vivo"
    assert.match(html, /1 vivo</);
    // filas: #3964 y #3970
    assert.match(html, /#3964/);
    assert.match(html, /#3970/);
    // fase pill
    assert.match(html, /class="eq-ag-fase"[^>]*>dev</);
});

test('renderTeamAccordion calcula progreso% y barra indeterminada sin etaMs (CA-1)', () => {
    const html = equipo.renderTeamAccordion(sampleState());
    // 492000/600000 = 82%
    assert.match(html, />82%</);
    // sin etaMs → indeterminado, nunca NaN
    assert.ok(!/NaN/.test(html), 'no debe haber NaN');
    assert.match(html, /eq-ag-bar-indeterminate/);
});

test('agentProgress: 0 + indeterminate si falta etaMs (regla inquebrantable)', () => {
    assert.deepEqual(equipo.agentProgress(60000, null), { pct: 0, indeterminate: true });
    assert.deepEqual(equipo.agentProgress(60000, 0), { pct: 0, indeterminate: true });
    assert.deepEqual(equipo.agentProgress(300000, 600000), { pct: 50, indeterminate: false });
    // cap a 100
    assert.equal(equipo.agentProgress(900000, 600000).pct, 100);
});

test('renderTeamAccordion incluye link a log sólo para agentes con log (CA-1)', () => {
    const html = equipo.renderTeamAccordion(sampleState());
    assert.match(html, /\/logs\/view\/agent-3964\.log/);
});

// ---------------------------------------------------------------------------
// #4335 — El link al log DEBE renderizarse también para las presencias
// observacionales (Commander/Sherlock). Regresión del rebote review: antes
// equipo.js:224 excluía `observational`, con lo que el slice seteaba
// hasLog/logFile pero el HTML nunca exponía el <a>. Estos tests assertan el
// HTML renderizado (no sólo el slice), que es lo que faltaba.
// ---------------------------------------------------------------------------

test('renderTeamAccordion renderiza el link al log para presencia observacional con hasLog (#4335)', () => {
    const html = equipo.renderTeamAccordion(sampleState({
        agentPersona: {
            commander: { icon: '🎖', name: 'Commander', color: '#f778ba' },
            sherlock: { icon: '🕵️', name: 'Sherlock', color: '#e3b341' },
        },
        teamAgents: [
            {
                issue: null, skill: 'commander', pipeline: null, fase: 'pensando',
                title: 'Commander', durationMs: 5000, etaMs: null,
                observational: true, cancelable: false,
                hasLog: true, logFile: 'commander-12345.log',
            },
            {
                issue: null, skill: 'sherlock', pipeline: null, fase: 'verificando',
                title: 'Sherlock', durationMs: 3000, etaMs: null,
                observational: true, cancelable: false,
                hasLog: true, logFile: 'sherlock-67890.log',
            },
        ],
    }));
    // El HTML renderizado contiene el <a> hacia el visor de logs con ?live=1.
    assert.match(html, /<a class="eq-ag-log" href="\/logs\/view\/commander-12345\.log\?live=1"/);
    assert.match(html, /<a class="eq-ag-log" href="\/logs\/view\/sherlock-67890\.log\?live=1"/);
    // Sigue siendo observacional → protegido, sin botón de kill.
    assert.match(html, /protegido/);
    assert.ok(!html.includes('eq-ag-kill'), 'presencia observacional no debe tener kill');
});

test('renderTeamAccordion NO linkea log si la presencia observacional no tiene log vigente (#4335)', () => {
    const html = equipo.renderTeamAccordion(sampleState({
        agentPersona: { commander: { icon: '🎖', name: 'Commander', color: '#f778ba' } },
        teamAgents: [{
            issue: null, skill: 'commander', pipeline: null, fase: 'pensando',
            title: 'Commander', durationMs: 5000, etaMs: null,
            observational: true, cancelable: false, hasLog: false,
        }],
    }));
    // Sin corrida vigente (hasLog=false) no hay log fantasma.
    assert.ok(!/eq-ag-log/.test(html), 'sin log vigente no debe renderizar link');
});

// ---------------------------------------------------------------------------
// CA-3 — Commander visible, sin kill, server-side guard
// ---------------------------------------------------------------------------

test('Commander se muestra visible pero SIN botón de kill (CA-3)', () => {
    const html = equipo.renderTeamAccordion(sampleState());
    // El bloque del commander no contiene eq-ag-kill
    const commanderCardStart = html.indexOf('data-skill="commander"');
    assert.ok(commanderCardStart > 0);
    const commanderCard = html.slice(commanderCardStart);
    assert.ok(!commanderCard.includes('eq-ag-kill'), 'commander no debe tener botón kill');
    assert.match(commanderCard, /protegido/);
    assert.match(html, /skill no cancelable/);
});

test('teamAgentRow de un agente cancelable SÍ tiene botón kill con CSRF-aware killAgent', () => {
    const row = equipo.teamAgentRow({
        issue: '100', skill: 'backend-dev', pipeline: 'desarrollo', fase: 'dev',
        title: 't', durationMs: 1000, etaMs: 2000, cancelable: true,
    });
    assert.match(row, /eq-ag-kill/);
    assert.match(row, /killAgent\('100','backend-dev','desarrollo','dev',1000\)/);
});

// ---------------------------------------------------------------------------
// CA-4 / SEC-6 — cooldown server-authoritative con countdown
// ---------------------------------------------------------------------------

test('renderTeamAccordion pinta cooldown con data-cooldown-until y "en espera" (CA-4)', () => {
    const html = equipo.renderTeamAccordion(sampleState());
    assert.match(html, /eq-ag-cooldown/);
    assert.match(html, /data-cooldown-until="20\d\d-/);
    assert.match(html, /en espera/);
    assert.match(html, /2 fallos/);
});

test('cooldownFor: activo / expirado / ausente (SEC-6)', () => {
    const now = Date.now();
    const active = slices.cooldownFor({ 'a:1': { failures: 3, cooldownUntil: new Date(now + 60000).toISOString() } }, 'a', '1', now);
    assert.equal(active.failures, 3);
    assert.equal(slices.cooldownFor({ 'a:1': { failures: 1, cooldownUntil: new Date(now - 1000).toISOString() } }, 'a', '1', now), null);
    assert.equal(slices.cooldownFor({}, 'b', '2', now), null);
    assert.equal(slices.cooldownFor(null, 'b', '2', now), null);
});

// ---------------------------------------------------------------------------
// CA-5 — sparkline 24h
// ---------------------------------------------------------------------------

test('skillSparkline emite 24 barras con dual-encoding (title) (CA-5)', () => {
    const html = equipo.skillSparkline([0, 1, 2, 0, 0, 3, 0, 0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 4]);
    const bars = (html.match(/class="eq-spark-bar/g) || []).length;
    assert.equal(bars, 24);
    assert.match(html, /eq-spark-bar-recent/); // últimas 6 resaltadas
    assert.match(html, /hace 0h/); // bucket más reciente
});

test('skillSparkline tolera buckets vacíos/ausentes sin romper (CA-5)', () => {
    assert.doesNotThrow(() => equipo.skillSparkline(undefined));
    assert.doesNotThrow(() => equipo.skillSparkline([]));
});

test('skillSpark24h derivado del FS retorna mapa por skill (CA-5)', () => {
    // state mínimo: sin fases reales → mapa vacío, sin throw.
    const spark = slices.skillSpark24h({ allFases: [] }, Date.now());
    assert.equal(typeof spark, 'object');
});

// ---------------------------------------------------------------------------
// SEC-5 — escape XSS del título de issue (atacante-controlable)
// ---------------------------------------------------------------------------

test('renderTeamAccordion escapa el título malicioso del issue (SEC-5)', () => {
    const html = equipo.renderTeamAccordion(sampleState({
        teamAgents: [{
            issue: '666', skill: 'android-dev', pipeline: 'desarrollo', fase: 'dev',
            title: '<img src=x onerror=alert(1)>', durationMs: 1000, etaMs: 2000, cancelable: true,
        }],
    }));
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'no debe inyectar el HTML crudo');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ---------------------------------------------------------------------------
// SEC-1/2/3 — hardening del handler /api/kill-agent (estructura del source)
// ---------------------------------------------------------------------------

const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

test('handler /api/kill-agent valida inputs contra allowlist + regex (SEC-1)', () => {
    const i = dashboardSrc.indexOf("if (req.url === '/api/kill-agent' && req.method === 'POST')");
    assert.ok(i > 0, 'handler debe existir');
    const body = dashboardSrc.slice(i, i + 3000);
    assert.match(body, /cfg\.pipelines\[pl\]/, 'valida pipeline contra config');
    assert.match(body, /fases\.includes\(fase\)/, 'valida fase contra allowlist');
    assert.match(body, /\/\^\[0-9\]\+\$\/\.test\(String\(issue\)\)/, 'valida issue numérico');
    assert.match(body, /\/\^\[a-z0-9-\]\+\$\/\.test\(String\(skill\)\)/, 'valida skill');
});

test('handler /api/kill-agent rechaza commander 403 server-side (SEC-3)', () => {
    const i = dashboardSrc.indexOf("if (req.url === '/api/kill-agent' && req.method === 'POST')");
    const body = dashboardSrc.slice(i, i + 3000);
    assert.match(body, /NO_CANCELABLE\s*=\s*new Set\(\['commander'\]\)/);
    assert.match(body, /skill no cancelable/);
});

test('handler /api/kill-agent verifica CSRF antes de tocar el FS (SEC-2)', () => {
    const i = dashboardSrc.indexOf("if (req.url === '/api/kill-agent' && req.method === 'POST')");
    const body = dashboardSrc.slice(i, i + 1200);
    // El requireCSRF aparece ANTES del primer path.join del handler.
    const csrfIdx = body.indexOf('requireCSRF');
    const fsIdx = body.indexOf('renameSync');
    assert.ok(csrfIdx > 0, 'debe llamar requireCSRF');
    assert.ok(fsIdx === -1 || csrfIdx < fsIdx, 'CSRF antes de cualquier renameSync');
    assert.match(dashboardSrc, /\/api\/kill-agent\/csrf-token/);
});

// ---------------------------------------------------------------------------
// #4335 — Path fallback (activeStripHTML): las cards observacionales de la tira
// "Ejecutando ahora" en dashboard.js también deben cablear el link al log vía
// el helper presenceLogLink (resolver server-side mtime+TTL, ?live=1).
// ---------------------------------------------------------------------------

test('dashboard.js cablea presenceLogLink en las cards observacionales de Commander y Sherlock (#4335)', () => {
    // El helper existe y reusa el resolver del slice (no duplica la lógica).
    assert.match(dashboardSrc, /function presenceLogLink\(prefix, ttlMs\)/);
    assert.match(dashboardSrc, /_architectSlices\.resolveRecentRunLog\(prefix, ttlMs\)/);
    assert.match(dashboardSrc, /\/logs\/view\/'\s*\+\s*encodeURIComponent\(String\(logFile\)\)\s*\+\s*'\?live=1'/);
    // Ambas cards lo invocan con su prefijo/TTL.
    assert.match(dashboardSrc, /presenceLogLink\('commander', COMMANDER_PRESENCE_TTL_MS\)/);
    assert.match(dashboardSrc, /presenceLogLink\('sherlock', SHERLOCK_PRESENCE_TTL_MS\)/);
});

// ---------------------------------------------------------------------------
// SEC-2 — módulo CSRF: double-submit + synchronizer token
// ---------------------------------------------------------------------------

test('kill-agent-csrf: token válido pasa, ausente/mismatch/garbage → 403', () => {
    killCsrf._resetForTests();
    const mkReq = (method, headers) => ({ method, headers: headers || {} });
    const mkRes = () => ({ writeHead(s) { this._s = s; }, end(b) { this._b = b; } });

    // Sin token → 403
    let res = mkRes();
    assert.equal(killCsrf.requireCSRF(mkReq('POST', {}), res), false);
    assert.equal(res._s, 403);

    // Token válido + cookie igual → ok
    const tok = killCsrf.generateToken();
    res = mkRes();
    assert.equal(killCsrf.requireCSRF(mkReq('POST', { 'x-csrf-token': tok, cookie: 'ka_csrf=' + tok }), res), true);

    // Mismatch header vs cookie → 403
    res = mkRes();
    assert.equal(killCsrf.requireCSRF(mkReq('POST', { 'x-csrf-token': tok, cookie: 'ka_csrf=otro' }), res), false);
    assert.equal(res._s, 403);

    // Token no emitido → 403
    res = mkRes();
    assert.equal(killCsrf.requireCSRF(mkReq('POST', { 'x-csrf-token': 'fake', cookie: 'ka_csrf=fake' }), res), false);
    assert.equal(res._s, 403);

    // GET no requiere token
    assert.equal(killCsrf.requireCSRF(mkReq('GET', {}), mkRes()), true);
});

// ---------------------------------------------------------------------------
// SEC-2 — todos los call sites cliente migrados a killAgentPost (CSRF)
// ---------------------------------------------------------------------------

test('ningún call site cliente hace POST crudo a /api/kill-agent sin CSRF (SEC-2)', () => {
    const files = [
        '../views/dashboard/home.js',
        '../views/dashboard/satellites.js',
        '../views/dashboard/descanso.js',
    ];
    for (const rel of files) {
        const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        // El único fetch directo permitido vive en killAgentPost (fetch-client).
        const rawPost = /fetch\('\/api\/kill-agent'\s*,\s*\{[^}]*method:\s*'POST'/.test(src);
        assert.ok(!rawPost, rel + ' no debe hacer POST crudo a /api/kill-agent');
        assert.match(src, /killAgentPost\(/, rel + ' debe usar killAgentPost');
    }
    // killAgentPost vive en fetch-client (helper compartido).
    const fc = fs.readFileSync(path.join(__dirname, '../views/dashboard/fetch-client.js'), 'utf8');
    assert.match(fc, /async function killAgentPost/);
    assert.match(fc, /killCsrfHeaders/);
});

// ---------------------------------------------------------------------------
// SEC-4 — redacción de secrets en logs servidos
// ---------------------------------------------------------------------------

test('los logs servidos enmascaran JWT/AWS keys en todos los paths del handler (SEC-4)', () => {
    // Tras el merge con main (#3960 REQ-SEC-H7-1), el SSE de logs redacta vía
    // `_sanitizeLog` (sanitizer.sanitize) y la descarga raw vía `redactLogText`
    // (handoff.sanitize). Ambos cumplen SEC-4: ningún log sale crudo al browser.
    assert.match(dashboardSrc, /function redactLogText/);
    assert.match(dashboardSrc, /_sanitizeLog\s*=\s*require\('\.\/sanitizer'\)\.sanitize/);
    // SSE: stream inicial + append redactados con _sanitizeLog
    assert.match(dashboardSrc, /initialLines\s*=\s*lines\.slice\(-1000\)\.map\(l\s*=>\s*_sanitizeLog\(l\)\)/);
    assert.match(dashboardSrc, /\.map\(l\s*=>\s*_sanitizeLog\(l\)\)/);
    // Descarga raw del archivo de log redactada con redactLogText
    assert.match(dashboardSrc, /redactLogText\(fs\.readFileSync\(logPath, 'utf8'\)\)/);

    // Verificación funcional del redactor central reusado (handoff.sanitize).
    const { sanitize } = require('../lib/handoff.js');
    const out = sanitize('token AKIAIOSFODNN7EXAMPLE y jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij').text;
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key redactada');
    assert.match(out, /\[REDACTED:/);

    // Verificación funcional del sanitizer central del SSE (sanitizer.sanitize).
    const { sanitize: sseSanitize } = require('../sanitizer.js');
    const sseOut = sseSanitize('aws AKIAIOSFODNN7EXAMPLE');
    assert.ok(!sseOut.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key redactada en SSE');
});
