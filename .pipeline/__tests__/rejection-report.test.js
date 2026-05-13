// Tests del rejection report — issue #3088 (multi-provider en PDF + audio).
//
// Cubre:
//   CA-1: header del PDF muestra los 3 badges en orden correcto.
//   CA-2: audio menciona provider/model bajo regla determinística.
//   CA-3: 8 fixtures cross-provider + 2 regresión visual del header.
//   CA-6: getSessionContext es la single source of truth (sin inferencia).
//   CA-8: badge-gray monoespaciado para cli, truncamiento por max-width 240px.
//   CA-9: backward-compat: ausencia de --provider/--model/--cli-version OK.
//
// Vectores de injection (SEC-1, SEC-2, SEC-4, SEC-5):
//   - HTML: <script>, "><img onerror=, comilla doble, etc.
//   - shell: "; rm -rf /; #", "$(whoami)", backticks.
//   - shape-secret: AWS access key ID, JWT-shaped string.
//   - unicode/control chars: newline, tab, zero-width space.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// El módulo lee process.argv al cargarse — limpiamos para evitar contaminación.
const origArgv = process.argv;
process.argv = ['node', 'rejection-report.js'];
const rr = require('../rejection-report');
process.argv = origArgv;

const {
    renderSessionMeta, renderHtml, generateNarration,
    providerNarrationSuffix, isQualitativeFailure,
    resolveSessionContext, escapeHtml,
} = rr;

// Fake del módulo de traceability para tests aislados (sin tocar disco real).
function fakeTraceability(sessionMap) {
    return {
        getSessionContext({ issue, skill }) {
            return sessionMap[`${skill}#${issue}`] || null;
        },
    };
}

// Fixture genérico de `data` para renderHtml/generateNarration.
function fixtureData(overrides) {
    return Object.assign({
        issue: '1234', skill: 'qa', fase: 'verificacion',
        exitCode: 1, elapsed: 45,
        motivo: 'Tests rojos en módulo X',
        timestamp: '13/05/2026 10:00:00',
        isoDate: '2026-05-13',
        issueCtx: { title: 'Test issue', labels: [] },
        rejectHistory: [],
        logTail: '(log)',
        readableLog: '(log)',
        depIssues: { linkedDeps: [] },
        autoCreatedDeps: [],
        preflight: { ok: true, line: 'check 4 OK' },
        evidence: { video: null, frames: 0, logPath: null, logBytes: 0 },
        primaryCause: { summary: 'Causa X', detail: 'detalle', source: 'auto', priority: 'normal', origen: 'INTERNO' },
        verdict: 'RECHAZADO_CON_CAUSA',
        inconclusive: false,
        sessionCtx: {
            provider: 'anthropic', model: 'claude-sonnet-4-6', cliVersion: '0.7.2',
            firstWithCombo: false, recentSwitch: false,
        },
    }, overrides || {});
}

// ---------------------------------------------------------------------------
// CA-1 + CA-8: header con 3 badges en orden correcto + clases CSS
// ---------------------------------------------------------------------------

test('CA-1: header del PDF incluye los 3 badges en orden provider → model → cli', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: { provider: 'anthropic', model: 'claude-sonnet-4-6', cliVersion: '0.7.2' },
    }));
    const metaMatch = html.match(/<p class="session-meta">[\s\S]*?<\/p>/);
    assert.ok(metaMatch, 'session-meta block presente');
    const meta = metaMatch[0];
    assert.ok(meta.includes('provider: anthropic'));
    assert.ok(meta.includes('model: claude-sonnet-4-6'));
    assert.ok(meta.includes('cli: 0.7.2'));
    assert.ok(meta.indexOf('provider:') < meta.indexOf('model:'), 'provider antes que model');
    assert.ok(meta.indexOf('model:') < meta.indexOf('cli:'), 'model antes que cli');
});

test('CA-1: clases CSS correctas — badge-blue para provider/model, badge-gray para cli', () => {
    const html = renderHtml(fixtureData());
    // provider y model usan badge-blue (consistencia semántica con "fuente")
    const meta = html.match(/<p class="session-meta">[\s\S]*?<\/p>/)[0];
    const providerSpan = meta.match(/<span class="badge badge-blue[^"]*"[^>]*>provider:/);
    const modelSpan = meta.match(/<span class="badge badge-blue[^"]*"[^>]*>model:/);
    const cliSpan = meta.match(/<span class="badge badge-gray[^"]*"[^>]*>cli:/);
    assert.ok(providerSpan, 'provider tiene badge-blue');
    assert.ok(modelSpan, 'model tiene badge-blue');
    assert.ok(cliSpan, 'cli tiene badge-gray');
});

test('CA-1: header incluye el CSS .badge-gray y .session-meta', () => {
    const html = renderHtml(fixtureData());
    assert.ok(html.includes('.badge-gray'), 'CSS .badge-gray presente');
    assert.ok(html.includes('.session-meta'), 'CSS .session-meta presente');
    assert.ok(html.includes('#ecf0f1'), 'fondo gris claro presente');
    assert.ok(html.includes('#555'), 'color gris oscuro presente');
});

test('CA-1: bloque session-meta aparece entre badge de veredicto y h2 Issue bajo prueba', () => {
    const html = renderHtml(fixtureData());
    const idxVerdict = html.indexOf('badge-red'); // veredicto rechazado
    const idxMeta = html.indexOf('session-meta');
    const idxH2 = html.indexOf('<h2>Issue bajo prueba</h2>');
    assert.ok(idxVerdict !== -1 && idxMeta !== -1 && idxH2 !== -1);
    assert.ok(idxVerdict < idxMeta, 'meta después del badge de veredicto');
    assert.ok(idxMeta < idxH2, 'meta antes del h2');
});

// ---------------------------------------------------------------------------
// CA-3 fixtures cross-provider (1-3): happy paths
// ---------------------------------------------------------------------------

test('CA-3 fixture 1 (anthropic + claude-sonnet-4-6 + 0.7.2): render limpio', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: { provider: 'anthropic', model: 'claude-sonnet-4-6', cliVersion: '0.7.2' },
    }));
    assert.ok(html.includes('provider: anthropic'));
    assert.ok(html.includes('model: claude-sonnet-4-6'));
    assert.ok(html.includes('cli: 0.7.2'));
});

test('CA-3 fixture 2 (openai + gpt-5-codex + codex-cli-1.4.0): render limpio', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: { provider: 'openai', model: 'gpt-5-codex', cliVersion: 'codex-cli-1.4.0' },
    }));
    assert.ok(html.includes('provider: openai'));
    assert.ok(html.includes('model: gpt-5-codex'));
    assert.ok(html.includes('cli: codex-cli-1.4.0'));
});

test('CA-3 fixture 3 (deterministic + deterministic + n/a): render limpio', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: { provider: 'deterministic', model: 'deterministic', cliVersion: 'n/a' },
    }));
    assert.ok(html.includes('provider: deterministic'));
    assert.ok(html.includes('model: deterministic'));
    assert.ok(html.includes('cli: n/a'));
});

// ---------------------------------------------------------------------------
// CA-3 fixture 4: audit trail vacío → 3 badges con literal "unknown"
// ---------------------------------------------------------------------------

test('CA-3 fixture 4 (audit vacío / getSessionContext null): 3 badges en unknown', () => {
    const ctx = resolveSessionContext('1', 'qa', {
        traceabilityImpl: fakeTraceability({}),
        argProvider: null, argModel: null, argCliVersion: null,
    });
    assert.equal(ctx.provider, 'unknown');
    assert.equal(ctx.model, 'unknown');
    assert.equal(ctx.cliVersion, 'unknown');

    const html = renderHtml(fixtureData({ sessionCtx: ctx }));
    const meta = html.match(/<p class="session-meta">[\s\S]*?<\/p>/)[0];
    const matches = meta.match(/unknown/g) || [];
    assert.ok(matches.length >= 3, `al menos 3 ocurrencias de "unknown", got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// CA-3 fixture 5: vector HTML injection — no nodos DOM extra
// ---------------------------------------------------------------------------

test('CA-3 fixture 5 (vector HTML injection): valores escapados literalmente', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: {
            provider: '<script>alert(1)</script>',
            model: '"><img src=x onerror=fetch(1)>',
            cliVersion: 'v"><img/>',
        },
    }));
    const meta = html.match(/<p class="session-meta">[\s\S]*?<\/p>/)[0];
    // No debe haber un <script> "real" dentro del bloque meta. Después de
    // escapeHtml, los `<` se convierten en `&lt;` y nunca se cierra un tag.
    assert.ok(!/<script\b/i.test(meta), 'no debe haber <script> real');
    // No debe haber un <img> real (con o sin onerror). El parser HTML sólo
    // crearía un tag si encontrara un `<` literal seguido del nombre.
    assert.ok(!/<img\b/i.test(meta), 'no debe haber <img> real');
    // El nombre del atributo `onerror=` puede aparecer como TEXTO dentro de
    // la entidad escapada (`&lt;img ... onerror=fetch(1)&gt;`) — eso es
    // seguro porque no hay tag abierto en HTML. Verificamos que cualquier
    // ocurrencia de `onerror=` viene precedida de `&lt;img` (texto escapado),
    // nunca de `<img` (tag real). Defensa en profundidad.
    const realOnerror = /<img[^>]*\sonerror=/i.test(meta);
    assert.ok(!realOnerror, 'no debe haber onerror= como atributo de un <img> real');
    // Sí debe estar el valor escapado literalmente.
    assert.ok(meta.includes('&lt;script&gt;'), 'script escapado');
    assert.ok(meta.includes('&quot;&gt;&lt;img'), 'img escapado');
});

// ---------------------------------------------------------------------------
// CA-3 fixture 6: vector shell injection en cli/model — el audio no ejecuta nada
// ---------------------------------------------------------------------------

test('CA-3 fixture 6 (vector shell injection): generateNarration nunca interpola en shell', () => {
    // Lo que importa para SEC-2 es que el VALOR aparezca literal en el string
    // de la narración y que el call site (sendReport → textToSpeech → spawn)
    // pase como args parametrizados. textToSpeech ya usa spawn(bin, args, ...).
    // Acá verificamos que la narración no rompe ante chars de shell.
    const data = fixtureData({
        sessionCtx: {
            provider: 'anthropic', model: '$(whoami)', cliVersion: '; rm -rf /; #',
            firstWithCombo: true, recentSwitch: false,
        },
    });
    const narration = generateNarration(data);
    assert.equal(typeof narration, 'string', 'narration es string, no objeto/eval');
    // cli_version NUNCA en audio (UX): la palabra "; rm -rf /; #" no debe aparecer.
    assert.ok(!narration.includes('rm -rf'));
    // El modelo sí puede aparecer en el audio si la regla 1/2 se activa.
    assert.ok(narration.includes('$(whoami)'), 'model literal en narración');
});

// ---------------------------------------------------------------------------
// CA-3 fixture 7: shape-secret en cli_version — `sanitizeReportText` redacta
// ---------------------------------------------------------------------------

test('CA-3 fixture 7 (shape-secret AWS/JWT): sanitizer redacta el HTML final', () => {
    // El render produce el HTML CRUDO con el valor; el sanitize (que corre en
    // sendReport antes del PDF) es el que redacta. Verificamos que el helper
    // de sanitización catchea AWS access keys y JWT-shaped strings cuando
    // viajan a través del HTML producido.
    const { sanitize: sanitizeReportText } = require('../sanitizer');
    const htmlAws = renderHtml(fixtureData({
        sessionCtx: { provider: 'anthropic', model: 'sonnet', cliVersion: 'AKIAIOSFODNN7EXAMPLE' },
    }));
    const sanitizedAws = sanitizeReportText(htmlAws);
    assert.ok(!sanitizedAws.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS Access Key ID redactada');

    // JWT shape: tres segmentos base64url separados por puntos.
    const fakeJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.Sflk5wRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const htmlJwt = renderHtml(fixtureData({
        sessionCtx: { provider: 'anthropic', model: 'sonnet', cliVersion: fakeJwt },
    }));
    const sanitizedJwt = sanitizeReportText(htmlJwt);
    assert.ok(!sanitizedJwt.includes(fakeJwt), 'JWT-shaped redactado');
});

// ---------------------------------------------------------------------------
// CA-3 fixture 8: unicode/control chars
// ---------------------------------------------------------------------------

test('CA-3 fixture 8 (unicode/control chars): render no rompe', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: {
            provider: 'anthropic',
            model: 'claude​-sonnet', // zero-width space
            cliVersion: 'v1\n\t2',          // newline + tab
        },
    }));
    // El HTML resultante sigue siendo válido y contiene los valores.
    assert.ok(html.includes('claude'));
    assert.ok(html.includes('sonnet'));
    // El parser podría comerse el zero-width pero al menos no debe haber
    // newlines no escapados que rompan el <p>.
    const meta = html.match(/<p class="session-meta">[\s\S]*?<\/p>/);
    assert.ok(meta, 'session-meta block sigue presente');
});

// ---------------------------------------------------------------------------
// Regresión visual extra (CA-3): orden + clases + truncamiento
// ---------------------------------------------------------------------------

test('regresión visual: truncamiento activo cuando model > 32 chars (max-width 240px)', () => {
    const longModel = 'this-is-a-very-long-model-name-of-far-more-than-32-chars';
    const html = renderHtml(fixtureData({
        sessionCtx: { provider: 'anthropic', model: longModel, cliVersion: '0.1' },
    }));
    const meta = html.match(/<p class="session-meta">[\s\S]*?<\/p>/)[0];
    assert.ok(meta.includes('badge-trunc'), 'aplica clase de truncamiento');
    assert.ok(meta.includes(`title="model: ${longModel}"`.replace('model: ', '')) || meta.match(/title="[^"]+"/), 'tooltip con valor completo');
});

test('regresión visual: provider NUNCA se trunca (sin badge-trunc en provider)', () => {
    const html = renderHtml(fixtureData({
        sessionCtx: { provider: 'a'.repeat(50), model: 'sonnet', cliVersion: '0.1' },
    }));
    const providerSpan = html.match(/<span class="badge badge-blue[^"]*"[^>]*>provider:[^<]*<\/span>/)[0];
    assert.ok(!providerSpan.includes('badge-trunc'), 'provider NO se trunca (G-UX-1)');
});

// ---------------------------------------------------------------------------
// CA-2: regla determinística en el audio
// ---------------------------------------------------------------------------

test('CA-2 regla 1 (primera sesión con combinación): frase literal completa', () => {
    const data = fixtureData({
        sessionCtx: {
            provider: 'anthropic', model: 'claude-sonnet-4-6', cliVersion: '0.7.2',
            firstWithCombo: true, recentSwitch: false,
        },
    });
    const narration = generateNarration(data);
    assert.ok(narration.includes(' Esta sesión corrió con anthropic claude-sonnet-4-6, primera vez con esta combinación.'));
});

test('CA-2 regla 2 (switch reciente): frase literal completa', () => {
    const data = fixtureData({
        sessionCtx: {
            provider: 'openai', model: 'gpt-5-codex', cliVersion: 'codex-cli-1.4.0',
            firstWithCombo: false, recentSwitch: true,
        },
    });
    const narration = generateNarration(data);
    assert.ok(narration.includes(' Esta sesión corrió con openai gpt-5-codex, hubo switch automático reciente.'));
});

test('CA-2 regla 3 (cualitativo no-deterministic sin trigger anterior): frase base sin trailer', () => {
    const data = fixtureData({
        motivo: 'Tests rojos en TestX',
        sessionCtx: {
            provider: 'anthropic', model: 'claude-sonnet-4-6', cliVersion: '0.7.2',
            firstWithCombo: false, recentSwitch: false,
        },
    });
    const narration = generateNarration(data);
    assert.ok(narration.includes(' Esta sesión corrió con anthropic claude-sonnet-4-6.'));
    assert.ok(!narration.includes('primera vez'));
    assert.ok(!narration.includes('switch automático'));
});

test('CA-2 ninguna regla (deterministic + infra failure): no menciona provider/model', () => {
    const data = fixtureData({
        motivo: 'Muerte prematura (8s, fallo #2)',
        sessionCtx: {
            provider: 'deterministic', model: 'deterministic', cliVersion: 'n/a',
            firstWithCombo: false, recentSwitch: false,
        },
    });
    const narration = generateNarration(data);
    assert.ok(!narration.includes('Esta sesión corrió con'));
});

test('CA-2 cli_version NUNCA aparece en audio', () => {
    const data = fixtureData({
        sessionCtx: {
            provider: 'anthropic', model: 'sonnet', cliVersion: 'cli-version-secreto',
            firstWithCombo: true, recentSwitch: false,
        },
    });
    const narration = generateNarration(data);
    assert.ok(!narration.includes('cli-version-secreto'));
    assert.ok(!narration.includes('0.7.2'));
    // El cli puede aparecer en el PDF, pero nunca en audio.
});

test('CA-2 NUNCA decir "unknown" en audio — si provider/model unknown, omitir frase entera', () => {
    const dataA = fixtureData({
        sessionCtx: { provider: 'unknown', model: 'sonnet', cliVersion: '0.1', firstWithCombo: true },
    });
    const dataB = fixtureData({
        sessionCtx: { provider: 'anthropic', model: 'unknown', cliVersion: '0.1', firstWithCombo: true },
    });
    assert.ok(!generateNarration(dataA).includes('unknown'));
    assert.ok(!generateNarration(dataB).includes('unknown'));
    assert.ok(!generateNarration(dataA).includes('Esta sesión corrió'));
    assert.ok(!generateNarration(dataB).includes('Esta sesión corrió'));
});

test('CA-2 orden fijo: provider antes que model', () => {
    const data = fixtureData({
        sessionCtx: { provider: 'openai', model: 'gpt-5', cliVersion: 'v1', firstWithCombo: true },
    });
    const narration = generateNarration(data);
    const idxP = narration.indexOf('openai');
    const idxM = narration.indexOf('gpt-5');
    assert.ok(idxP !== -1 && idxM !== -1);
    assert.ok(idxP < idxM, 'provider antes que model');
});

// ---------------------------------------------------------------------------
// CA-2 — determinismo: misma data → misma frase literal (SEC-6)
// ---------------------------------------------------------------------------

test('CA-2 determinismo: 100 ejecuciones producen exactamente el mismo audio', () => {
    const data = fixtureData({
        sessionCtx: {
            provider: 'anthropic', model: 'sonnet', cliVersion: '0.1',
            firstWithCombo: true, recentSwitch: false,
        },
    });
    const ref = generateNarration(data);
    for (let i = 0; i < 100; i++) {
        assert.equal(generateNarration(data), ref, `iter ${i} difiere — reproducibilidad rota`);
    }
});

// ---------------------------------------------------------------------------
// CA-9 backward-compat
// ---------------------------------------------------------------------------

test('CA-9: sin --provider/--model/--cli-version → resolveSessionContext devuelve unknown sin throw', () => {
    const ctx = resolveSessionContext('1234', 'qa', {
        traceabilityImpl: fakeTraceability({}),
        argProvider: null, argModel: null, argCliVersion: null,
    });
    assert.deepEqual({
        provider: ctx.provider, model: ctx.model, cliVersion: ctx.cliVersion,
    }, { provider: 'unknown', model: 'unknown', cliVersion: 'unknown' });
});

test('CA-9: con --provider/--model/--cli-version (CLI args ganan al audit)', () => {
    const ctx = resolveSessionContext('1234', 'qa', {
        traceabilityImpl: fakeTraceability({
            'qa#1234': { provider: 'audit-prov', model: 'audit-model', cli_version: 'audit-cli' },
        }),
        argProvider: 'cli-prov', argModel: 'cli-model', argCliVersion: 'cli-ver',
    });
    assert.equal(ctx.provider, 'cli-prov');
    assert.equal(ctx.model, 'cli-model');
    assert.equal(ctx.cliVersion, 'cli-ver');
});

test('CA-6: sin CLI args pero con audit context → usa audit (single source of truth)', () => {
    const ctx = resolveSessionContext('1234', 'qa', {
        traceabilityImpl: fakeTraceability({
            'qa#1234': { provider: 'audit-prov', model: 'audit-model', cli_version: 'audit-cli', first_with_combo: true, recent_switch: false },
        }),
        argProvider: null, argModel: null, argCliVersion: null,
    });
    assert.equal(ctx.provider, 'audit-prov');
    assert.equal(ctx.model, 'audit-model');
    assert.equal(ctx.cliVersion, 'audit-cli');
    assert.equal(ctx.firstWithCombo, true);
});

// ---------------------------------------------------------------------------
// SEC-3: NUNCA inferir provider por substring del model
// ---------------------------------------------------------------------------

test('SEC-3: si audit dice provider=anthropic pero model=gpt-codex, NO infiere openai', () => {
    const ctx = resolveSessionContext('1', 'qa', {
        traceabilityImpl: fakeTraceability({
            'qa#1': { provider: 'anthropic', model: 'gpt-5-codex', cli_version: '0.1' },
        }),
    });
    assert.equal(ctx.provider, 'anthropic'); // respeta audit, no infiere
    assert.equal(ctx.model, 'gpt-5-codex');
});

// ---------------------------------------------------------------------------
// isQualitativeFailure (CA-2 regla 3 — heurística)
// ---------------------------------------------------------------------------

test('isQualitativeFailure: muerte prematura → false (infra)', () => {
    assert.equal(isQualitativeFailure('Muerte prematura (8s, fallo #1)'), false);
});

test('isQualitativeFailure: timeout → false', () => {
    assert.equal(isQualitativeFailure('timeout esperando emulador'), false);
});

test('isQualitativeFailure: quota → false', () => {
    assert.equal(isQualitativeFailure('quota exhausted'), false);
});

test('isQualitativeFailure: tests rojos → true (cualitativo)', () => {
    assert.equal(isQualitativeFailure('Tests rojos en TestX'), true);
});

test('isQualitativeFailure: motivo vacío → true (default)', () => {
    assert.equal(isQualitativeFailure(''), true);
    assert.equal(isQualitativeFailure(null), true);
});

// ---------------------------------------------------------------------------
// SEC-1: escapeHtml escapa &, <, >, "
// ---------------------------------------------------------------------------

test('SEC-1: escapeHtml escapa los chars peligrosos', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('"><img>'), '&quot;&gt;&lt;img&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});
