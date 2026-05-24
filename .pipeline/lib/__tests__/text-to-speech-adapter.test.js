// =============================================================================
// text-to-speech-adapter.test.js — Tests unitarios (issue #2958)
//
// Cobertura:
//   - CA-3: emojis decorativos omitidos.
//   - CA-4: modelos IA preservados por default (#3505), strippables con flag.
//   - CA-5: paths / hashes / URLs reformulados.
//   - CA-6: markdown estructural fuera del audio.
//   - CA-7: tablas cortas reformuladas a frase natural.
//   - CA-8: resumen heuristico si > 1500 chars.
//   - CA-9: idempotencia.
//   - CA-10: redaccion de secretos ANTES de limpieza visual.
//   - CA-11: cap de input + proteccion ReDoS.
//   - CA-12: telemetria sin contenido textual.
//   - CA-14: fixtures sin PII / tokens reales.
//
// Estilo: node:test + node:assert. Sin dependencias externas.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    textToSpeechScript,
    sanitizeForTts,
    redactSecretsInText,
    MAX_TTS_INPUT_CHARS,
} = require('../text-to-speech-adapter');

// -----------------------------------------------------------------------------
// CA-3 — Emojis decorativos
// -----------------------------------------------------------------------------

test('CA-3: emojis decorativos se omiten del guion', () => {
    const input = 'PR #2891 mergeado ✅ con tests verdes 🎉';
    const { script, droppedCategories } = textToSpeechScript(input);
    assert.ok(!/✅/.test(script), 'no debe contener emoji check verde');
    assert.ok(!/\u{1F389}/u.test(script), 'no debe contener emoji tada');
    assert.ok(/numero 2891/.test(script), 'debe convertir #2891 a "numero 2891"');
    assert.ok(droppedCategories.emoji >= 2, 'debe contar emojis removidos');
});

test('CA-3: simbolos de estado decorativos no se leen', () => {
    const { script } = textToSpeechScript('🟢 verde 🔴 rojo 🟡 amarillo');
    assert.ok(!/\u{1F7E2}|\u{1F534}|\u{1F7E1}/u.test(script));
    assert.ok(/verde/.test(script));
    assert.ok(/rojo/.test(script));
});

// -----------------------------------------------------------------------------
// CA-4 — Modelos IA
// -----------------------------------------------------------------------------

test('CA-4 (#3505): nombre de modelo IA se preserva por default', () => {
    const input = 'Sonnet 4.6 proceso el delivery del PR';
    const { script, droppedCategories } = textToSpeechScript(input);
    assert.ok(/Sonnet/i.test(script), `debe conservar Sonnet por default, output=${script}`);
    assert.equal(droppedCategories.model, 0, 'no debe contar strips de modelo por default');
});

test('CA-4 (#3505): opts.preserveModelNames=true conserva nombres (explicito)', () => {
    const input = 'Sonnet 4.6 reemplazo a Opus 4.7 como default';
    const { script } = textToSpeechScript(input, { preserveModelNames: true });
    assert.ok(/Sonnet/i.test(script), 'debe conservar Sonnet con flag explicito');
    assert.ok(/Opus/i.test(script), 'debe conservar Opus con flag explicito');
});

test('CA-4 (#3505): opts.preserveModelNames=false strippea nombres (opt-out)', () => {
    const input = 'Sonnet 4.6 proceso el delivery del PR';
    const { script, droppedCategories } = textToSpeechScript(input, { preserveModelNames: false });
    assert.ok(!/Sonnet/i.test(script), `con opt-out NO debe mencionar Sonnet, output=${script}`);
    assert.ok(droppedCategories.model >= 1);
});

test('CA-4 (#3505): GPT-4o se preserva por default, se strippea con opt-out', () => {
    const def = textToSpeechScript('GPT-4o fallo en el delivery').script;
    assert.ok(/GPT-?4o/i.test(def), 'por default debe preservar GPT-4o');

    const optOut = textToSpeechScript('GPT-4o fallo en el delivery', { preserveModelNames: false }).script;
    assert.ok(!/GPT-?4o/i.test(optOut));
});

test('CA-4 (#3505): Claude/Gemini/Cerebras/Codex preservados por default', () => {
    const input = 'Claude, Gemini, Cerebras y Codex son los proveedores soportados';
    const { script } = textToSpeechScript(input);
    assert.ok(/Claude/.test(script));
    assert.ok(/Gemini/.test(script));
    assert.ok(/Cerebras/i.test(script));
    assert.ok(/Codex/i.test(script));
});

// -----------------------------------------------------------------------------
// CA-5 — Paths, hashes, URLs
// -----------------------------------------------------------------------------

test('CA-5: path Windows se reemplaza por "archivo del pipeline"', () => {
    const { script, droppedCategories } = textToSpeechScript(
        'edite C:\\Workspaces\\Intrale\\platform\\.pipeline\\lib\\foo.js correctamente'
    );
    assert.ok(!/C:\\/.test(script));
    assert.ok(/archivo del pipeline/.test(script));
    assert.ok(droppedCategories.path >= 1);
});

test('CA-5: path Unix relativo .pipeline/foo.js se reemplaza', () => {
    const { script } = textToSpeechScript('mira .pipeline/multimedia.js para ver detalles');
    assert.ok(!/\.pipeline\/multimedia\.js/.test(script));
    assert.ok(/archivo del pipeline/.test(script));
});

test('CA-5: hash de commit (7-40 hex) se reemplaza por "commit reciente"', () => {
    const { script, droppedCategories } = textToSpeechScript(
        'el commit 75fc4efa12345 quedo en main'
    );
    assert.ok(!/75fc4efa/.test(script));
    assert.ok(/commit reciente/.test(script));
    assert.ok(droppedCategories.hash >= 1);
});

test('CA-5: URL de issue GitHub se reformula', () => {
    const { script } = textToSpeechScript(
        'detalles en https://github.com/intrale/platform/issues/2958'
    );
    assert.ok(!/https:\/\//.test(script));
    assert.ok(/link al issue 2958/.test(script));
});

test('CA-5: URL de PR GitHub se reformula', () => {
    const { script } = textToSpeechScript(
        'el PR https://github.com/intrale/platform/pull/3312 esta listo'
    );
    assert.ok(/link al PR 3312/.test(script));
});

test('CA-5: URL generica se reemplaza por "link adjunto"', () => {
    const { script } = textToSpeechScript('mira https://example.com/algo/largo?x=1 para info');
    assert.ok(!/https?:\/\//.test(script));
    assert.ok(/link adjunto/.test(script));
});

// -----------------------------------------------------------------------------
// CA-6 — Markdown estructural
// -----------------------------------------------------------------------------

test('CA-6: headers markdown no se leen literal', () => {
    const { script } = textToSpeechScript('# Titulo\n## Subtitulo\nTexto.');
    assert.ok(!/^#/.test(script));
    assert.ok(/Titulo/.test(script));
    assert.ok(/Subtitulo/.test(script));
});

test('CA-6: code blocks triple-backtick se descartan', () => {
    const { script } = textToSpeechScript('antes\n```js\nconst x = 1;\n```\ndespues');
    assert.ok(!/const x = 1/.test(script));
    assert.ok(/antes/.test(script) && /despues/.test(script));
});

test('CA-6: negritas e italicas no se leen como asteriscos', () => {
    const { script } = textToSpeechScript('texto **importante** y *enfatico* aqui');
    assert.ok(!/\*\*/.test(script));
    assert.ok(/importante/.test(script));
    assert.ok(/enfatico/.test(script));
});

test('CA-6: bullets se aplanan', () => {
    const { script } = textToSpeechScript('items:\n- uno\n- dos\n- tres');
    assert.ok(!/^- /m.test(script));
    assert.ok(/uno/.test(script) && /dos/.test(script) && /tres/.test(script));
});

// -----------------------------------------------------------------------------
// CA-7 — Tablas cortas reformuladas a frase natural
// -----------------------------------------------------------------------------

test('CA-7: tabla corta (3 filas) se reformula a frase natural', () => {
    const tbl = [
        '| PR | estado |',
        '|---|---|',
        '| modelo | merged |',
        '| scripts | merged |',
        '| heuristica | merged |',
    ].join('\n');
    const { script, droppedCategories } = textToSpeechScript(tbl);
    assert.ok(droppedCategories.table >= 1, 'debe detectar tabla');
    assert.ok(!/^\|/m.test(script), 'no debe quedar pipe markdown');
    // Frase natural debe nombrar los items.
    assert.ok(/modelo/.test(script) && /scripts/.test(script) && /heuristica/.test(script));
});

test('CA-7: tabla larga (>4 filas) cae al fallback CSV', () => {
    const lines = ['| col |', '|---|'];
    for (let i = 1; i <= 6; i++) lines.push(`| valor${i} |`);
    const { script, droppedCategories } = textToSpeechScript(lines.join('\n'));
    // No debe reformularse como frase natural (>4 filas).
    assert.equal(droppedCategories.table, 0);
    // Pero tampoco quedar pipes literales — caen al fallback CSV linea por linea.
    assert.ok(!/\| valor/.test(script));
});

// -----------------------------------------------------------------------------
// CA-8 — Resumen heuristico
// -----------------------------------------------------------------------------

test('CA-8: texto <1500 chars NO se resume', () => {
    const input = 'parrafo corto. otra oracion.';
    const { script, summarized } = textToSpeechScript(input);
    assert.equal(summarized, false);
    assert.ok(script.length > 0);
});

test('CA-8: texto >1500 chars se resume preservando primer parrafo', () => {
    const para1 = 'Resumen ejecutivo del cambio importante en el sistema.';
    const filler = ' palabras de relleno repetidas para superar el limite.'.repeat(50);
    const input = `${para1}\n\n${filler}`;
    const { script, summarized } = textToSpeechScript(input);
    assert.equal(summarized, true);
    assert.ok(script.length <= 1500);
    assert.ok(script.includes('Resumen ejecutivo'), 'debe conservar primer parrafo');
});

test('CA-8: opts.summarize=false desactiva el resumen', () => {
    const input = 'oracion. '.repeat(400); // >1500 chars
    const { script, summarized } = textToSpeechScript(input, { summarize: false });
    assert.equal(summarized, false);
    assert.ok(script.length > 1500);
});

// -----------------------------------------------------------------------------
// CA-9 — Idempotencia
// -----------------------------------------------------------------------------

test('CA-9: adapter idempotente sobre input chat tipico', () => {
    const input = '## Status\n- PR #2891 mergeado ✅\n- commit 75fc4efa en main\n- mira https://github.com/intrale/platform/issues/2891';
    const first = textToSpeechScript(input).script;
    const second = textToSpeechScript(first).script;
    assert.equal(second, first, 'segundo paso debe ser igual al primero');
});

test('CA-9: idempotencia sobre input con secretos', () => {
    const jwt = 'eyJabcdefghij.klmnopqrstu.vwxyz12345';
    const input = `Authorization: Bearer ${jwt} fue usado en el request`;
    const first = textToSpeechScript(input).script;
    const second = textToSpeechScript(first).script;
    assert.equal(second, first);
});

test('CA-9: idempotencia sobre tabla', () => {
    const tbl = [
        '| item | estado |',
        '|---|---|',
        '| A | listo |',
        '| B | falla |',
    ].join('\n');
    const first = textToSpeechScript(tbl).script;
    const second = textToSpeechScript(first).script;
    assert.equal(second, first);
});

// -----------------------------------------------------------------------------
// CA-10 — Redaccion de secretos
// -----------------------------------------------------------------------------

test('CA-10: JWT real-shape se redacta como [REDACTED:jwt]', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MTIzNDUifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `token=${jwt} usado por el cliente`;
    const { script, droppedCategories } = textToSpeechScript(input);
    assert.ok(!script.includes(jwt), 'JWT no debe quedar en script');
    assert.ok(script.includes('[REDACTED:'), 'debe contener marcador REDACTED');
    assert.ok(droppedCategories.secret >= 1);
});

test('CA-10: AWS Access Key (AKIA...) se redacta', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const { script, droppedCategories } = textToSpeechScript(`uso ${key} para s3`);
    assert.ok(!script.includes(key));
    assert.ok(/REDACTED:aws-access-key/.test(script));
    assert.ok(droppedCategories.secret >= 1);
});

test('CA-10: Telegram bot token (digits:opaque) se redacta', () => {
    const token = '1234567890:ABCDEFghijklmnopqrstuvwxyz123456789';
    const { script, droppedCategories } = textToSpeechScript(`bot ${token} envio msg`);
    assert.ok(!script.includes(token));
    assert.ok(/REDACTED:telegram-bot-token/.test(script));
    assert.ok(droppedCategories.secret >= 1);
});

test('CA-10: Authorization: Bearer se redacta como auth-header', () => {
    const input = 'Authorization: Bearer abc123xyz456def789 fue rechazado';
    const { script } = textToSpeechScript(input);
    assert.ok(!script.includes('abc123xyz456def789'));
    assert.ok(/REDACTED:auth-header/.test(script));
});

test('CA-10: password= y api_key= en query strings se redactan', () => {
    const input = 'url?password=secreto123&api_key=xyzABC987&other=ok';
    const { script } = textToSpeechScript(input);
    assert.ok(!script.includes('secreto123'));
    assert.ok(!script.includes('xyzABC987'));
    assert.ok(/REDACTED:query-secret/.test(script));
});

test('CA-10: secretos se redactan ANTES de tabla / markdown (no quedan residuales)', () => {
    const jwt = 'eyJabcdefghij.klmnopqrstu.vwxyz12345';
    const tbl = `| col | valor |\n|---|---|\n| token | ${jwt} |`;
    const { script } = textToSpeechScript(tbl);
    assert.ok(!script.includes(jwt));
});

// -----------------------------------------------------------------------------
// CA-11 — Cap de input + proteccion ReDoS
// -----------------------------------------------------------------------------

test('CA-11: input > MAX_TTS_INPUT_CHARS se trunca y marca truncated=true', () => {
    const big = 'a'.repeat(MAX_TTS_INPUT_CHARS + 100);
    const result = textToSpeechScript(big);
    assert.equal(result.truncated, true);
    assert.ok(result.script.length <= MAX_TTS_INPUT_CHARS);
});

// Threshold anti-ReDoS: holgado para no ser flaky bajo carga del runner
// paralelo (140 archivos de test compiten por CPU en `node --test`), pero
// chico comparado con un ReDoS real (que demora segundos o cuelga). 2000ms
// = ~10x el tiempo en máquina ociosa (~80-250ms), y 5x-50x por debajo de
// cualquier patrón catastrófico real. Si esto se dispara, hay regresión
// genuina en los regex.
const REDOS_THRESHOLD_MS = 2000;

test('CA-11: input adversarial (10k chars + !) se procesa rapido (anti-ReDoS)', () => {
    const adversarial = 'a'.repeat(10000) + '!';
    const start = Date.now();
    textToSpeechScript(adversarial);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < REDOS_THRESHOLD_MS, `regex demoro ${elapsed}ms, debe ser <${REDOS_THRESHOLD_MS}`);
});

test('CA-11: path adversarial no causa ReDoS', () => {
    const adversarial = 'C:\\' + 'a'.repeat(5000) + '\\file.js';
    const start = Date.now();
    textToSpeechScript(adversarial);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < REDOS_THRESHOLD_MS, `path regex demoro ${elapsed}ms, debe ser <${REDOS_THRESHOLD_MS}`);
});

test('CA-11: URL adversarial no causa ReDoS', () => {
    const adversarial = 'https://' + 'a'.repeat(5000) + '.example.com';
    const start = Date.now();
    textToSpeechScript(adversarial);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < REDOS_THRESHOLD_MS, `url regex demoro ${elapsed}ms, debe ser <${REDOS_THRESHOLD_MS}`);
});

// -----------------------------------------------------------------------------
// CA-12 — Telemetria sin contenido
// -----------------------------------------------------------------------------

test('CA-12: droppedCategories tiene SOLO conteos, sin contenido textual', () => {
    const { droppedCategories } = textToSpeechScript('# Header\n- bullet\n✅ done #1234');
    // Todas las propiedades deben ser numeros.
    for (const [key, val] of Object.entries(droppedCategories)) {
        assert.equal(typeof val, 'number', `${key} debe ser numero, es ${typeof val}`);
    }
    // No debe haber arrays ni strings.
    assert.ok(!('droppedSegments' in droppedCategories));
});

// -----------------------------------------------------------------------------
// CA-9 / extra — sanitizeForTts compat
// -----------------------------------------------------------------------------

test('compat: sanitizeForTts devuelve string directo', () => {
    const out = sanitizeForTts('## Titulo\ntexto');
    assert.equal(typeof out, 'string');
    assert.ok(!/^#/.test(out));
});

test('compat: sanitizeForTts con null devuelve null', () => {
    assert.equal(sanitizeForTts(null), null);
});

test('compat: sanitizeForTts con undefined devuelve undefined', () => {
    assert.equal(sanitizeForTts(undefined), undefined);
});

// -----------------------------------------------------------------------------
// Fixtures realistas (CA-14: anonimizadas, sin PII real)
// -----------------------------------------------------------------------------

test('fixture: /status report anonimizado', () => {
    const status = [
        '## Estado del Pipeline',
        '',
        '🟢 3 issues en progreso',
        '',
        '| Issue | Estado |',
        '|---|---|',
        '| 2958 | dev |',
        '| 3300 | qa |',
        '| 3315 | review |',
        '',
        'Mas detalles en https://github.com/intrale/platform/issues/2958',
        '',
        'Sonnet 4.6 esta gestionando los rebotes.',
    ].join('\n');
    const { script, droppedCategories } = textToSpeechScript(status);
    assert.ok(!script.includes('🟢'));
    assert.ok(script.includes('Sonnet'), '#3505: nombre de modelo se preserva por default');
    assert.ok(!script.includes('https://'));
    assert.ok(/link al issue 2958/.test(script));
    assert.ok(droppedCategories.url >= 1);
    assert.equal(droppedCategories.model, 0, '#3505: cero strips de modelo por default');
});

test('fixture: rejection report con paths y secretos simulados', () => {
    const rejection = [
        '## Rechazo del issue numero 2891',
        '',
        'Build fallo en C:\\Workspaces\\Intrale\\platform\\backend\\src\\Main.kt',
        'Commit 75fc4efa12345 introdujo un secret accidentalmente.',
        'Authorization: Bearer eyJabcdefghij.klmnopqrstu.vwxyz12345 fue commiteado.',
        '',
        'PR https://github.com/intrale/platform/pull/3312 bloqueado.',
    ].join('\n');
    const { script, droppedCategories } = textToSpeechScript(rejection);
    assert.ok(!script.includes('C:\\'));
    assert.ok(!script.includes('75fc4efa'));
    assert.ok(!script.includes('eyJabcdefghij'));
    assert.ok(/link al PR 3312/.test(script));
    assert.ok(droppedCategories.path >= 1);
    assert.ok(droppedCategories.hash >= 1);
    assert.ok(droppedCategories.secret >= 1);
});

test('fixture: mensaje commander corto natural', () => {
    const msg = 'Bancame un toque, voy por el 60% del delivery del PR #3312 ✨';
    const { script } = textToSpeechScript(msg);
    assert.ok(/Bancame un toque/.test(script));
    assert.ok(!/✨/.test(script));
    assert.ok(/numero 3312/.test(script));
});

test('fixture: alerta de recuperacion infra', () => {
    const alert = [
        '🚨 Pipeline recuperado tras 12 minutos caido.',
        '',
        '- ETA proximo issue: 5 min',
        '- 4 issues en cola',
        '- 0 rebotes pendientes',
    ].join('\n');
    const { script } = textToSpeechScript(alert);
    assert.ok(!script.includes('🚨'));
    assert.ok(/Pipeline recuperado/.test(script));
    assert.ok(/ETA proximo issue/.test(script));
});

test('fixture (#3505): status en prosa preserva nombres de modelos IA por default', () => {
    const input = [
        '# Reporte diario',
        '',
        'Hoy dev corrio con Sonnet 4.6 y qa cerro con Opus 4.7.',
        'Cerebras fallo dos veces y Gemini cubrio el rebote.',
        '',
        'Sin incidentes.',
    ].join('\n');
    const { script, droppedCategories } = textToSpeechScript(input);
    assert.ok(script.includes('Sonnet'), '#3505: Sonnet se preserva en audio por default');
    assert.ok(script.includes('Opus'), '#3505: Opus se preserva en audio por default');
    assert.ok(/Cerebras/i.test(script), '#3505: Cerebras se preserva');
    assert.ok(/Gemini/i.test(script), '#3505: Gemini se preserva');
    assert.equal(droppedCategories.model, 0, '#3505: cero strips de modelo por default');
});

test('fixture (#3505): status con tabla y opt-out aplica strip de modelos', () => {
    const input = [
        '# Reporte diario',
        '',
        '| Skill | Provider |',
        '|---|---|',
        '| dev | Sonnet 4.6 |',
        '| qa | Opus 4.7 |',
        '',
        'Sin incidentes.',
    ].join('\n');
    const { script } = textToSpeechScript(input, { preserveModelNames: false });
    assert.ok(!script.includes('Sonnet'));
    assert.ok(!script.includes('Opus'));
});

// -----------------------------------------------------------------------------
// redactSecretsInText — funcion exportada para reuso.
// -----------------------------------------------------------------------------

test('redactSecretsInText: retorna count exacto', () => {
    const jwt1 = 'eyJabcdefghij.klmnopqrstu.vwxyz12345';
    const jwt2 = 'eyJfoobarbaza.qweuiopasd.0123456789xyz';
    const { text, count } = redactSecretsInText(`${jwt1} y ${jwt2}`);
    assert.equal(count, 2);
    assert.ok(!text.includes(jwt1));
    assert.ok(!text.includes(jwt2));
});

test('redactSecretsInText: input no string devuelve sin cambios', () => {
    const { text, count } = redactSecretsInText(null);
    assert.equal(text, null);
    assert.equal(count, 0);
});

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

test('input vacio devuelve script vacio sin error', () => {
    const { script, droppedCategories, summarized } = textToSpeechScript('');
    assert.equal(script, '');
    assert.equal(summarized, false);
    assert.equal(droppedCategories.markdown, 0);
});

test('input null devuelve script vacio', () => {
    const { script } = textToSpeechScript(null);
    assert.equal(script, '');
});

test('input numerico (no string) se convierte a string sin crashear', () => {
    const { script } = textToSpeechScript(12345);
    assert.equal(typeof script, 'string');
});
