// =============================================================================
// Tests para lib/telegram-reports.js — Issue #2904
//
// Cobertura:
//   - escapeMd cubre los 18 caracteres especiales de MarkdownV2
//   - dispatch con subcomando inválido devuelve el menú de ayuda (CA-3)
//   - dispatch sin subcomando devuelve el menú de ayuda (CA-2)
//   - dispatch con subcomandos válidos devuelve markdown no vacío (CA-1)
//   - VALID_SECTIONS expone exactamente las 7 secciones
//   - splitMessage parte mensajes >15 líneas y numera (CA-7)
//   - semaforoFromStatus mapea correctamente los estados conocidos
//   - sanitizeError no expone paths absolutos del SO (SR-3)
//
// El dashboard NO está corriendo durante estos tests (no aislamos puerto):
// los formatters degradan a FS fallback y devuelven markdown válido igualmente
// (CA-5).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reports = require('../telegram-reports');

// -----------------------------------------------------------------------------
// escapeMd — 18 caracteres especiales
// -----------------------------------------------------------------------------

test('escapeMd escapa los 18 caracteres especiales MarkdownV2', () => {
    const specials = '_ * [ ] ( ) ~ ` > # + - = | { } . !'.replace(/ /g, '');
    const out = reports.escapeMd(specials);
    // Cada caracter especial debe estar precedido por un backslash.
    for (const c of specials) {
        assert.match(out, new RegExp('\\\\\\' + c), `falta escape de ${c}`);
    }
});

test('escapeMd escapa también el backslash', () => {
    const out = reports.escapeMd('a\\b');
    assert.equal(out, 'a\\\\b');
});

test('escapeMd retorna string vacío con null/undefined', () => {
    assert.equal(reports.escapeMd(null), '');
    assert.equal(reports.escapeMd(undefined), '');
});

test('escapeMd no toca caracteres ASCII normales', () => {
    const out = reports.escapeMd('hola mundo 123');
    assert.equal(out, 'hola mundo 123');
});

test('escapeMd escapa títulos de issues típicos', () => {
    // Caso típico: "Fix bug en _login_ con [usuario]"
    const out = reports.escapeMd('Fix bug en _login_ con [usuario]');
    assert.match(out, /\\_login\\_/);
    assert.match(out, /\\\[usuario\\]/);
});

// -----------------------------------------------------------------------------
// VALID_SECTIONS — whitelist de subcomandos
// -----------------------------------------------------------------------------

test('VALID_SECTIONS expone exactamente las 7 secciones del issue', () => {
    const expected = ['agentes', 'cuota', 'sistema', 'pipeline', 'sprint', 'rebotes', 'all'];
    assert.deepEqual([...reports.VALID_SECTIONS].sort(), expected.sort());
});

test('VALID_SECTIONS está congelado (no se puede mutar)', () => {
    assert.throws(() => { reports.VALID_SECTIONS.push('new'); });
});

// -----------------------------------------------------------------------------
// dispatch — comportamiento del dispatcher (whitelist hardcoded SR-1)
// -----------------------------------------------------------------------------

test('dispatch sin sección devuelve el menú de ayuda (CA-2)', async () => {
    const r = await reports.dispatch();
    assert.equal(r.kind, 'help');
    assert.match(r.body, /Reportes Pipeline V3/);
});

test('dispatch con sección inválida devuelve el menú de ayuda (CA-3)', async () => {
    const r = await reports.dispatch('xyz-invalida');
    assert.equal(r.kind, 'help');
    assert.match(r.body, /Reportes Pipeline V3/);
});

test('dispatch con string vacío devuelve el menú de ayuda', async () => {
    const r = await reports.dispatch('   ');
    assert.equal(r.kind, 'help');
});

test('dispatch es case-insensitive (CUOTA, Cuota, cuota → mismo handler)', async () => {
    const r1 = await reports.dispatch('cuota');
    const r2 = await reports.dispatch('CUOTA');
    const r3 = await reports.dispatch('Cuota');
    assert.equal(r1.kind, 'report');
    assert.equal(r2.kind, 'report');
    assert.equal(r3.kind, 'report');
});

// Validamos que cada subcomando válido produce un report no vacío. Como el
// dashboard puede no estar corriendo, esperamos que el formato funcione con
// FS fallback (CA-5). No comparamos contenido exacto — solo no-vacío + header.
for (const section of ['agentes', 'cuota', 'sistema', 'pipeline', 'sprint', 'rebotes', 'all']) {
    test(`dispatch('${section}') devuelve report con header válido`, async () => {
        const r = await reports.dispatch(section);
        assert.equal(r.kind, 'report');
        assert.ok(r.body && r.body.length > 0, 'body vacío');
        // Header canónico: `*Seccion \- dd/mm HH:mm*` (UX-2).
        assert.match(r.body, /^\*[^*]+\\- \d{2}\/\d{2} \d{2}:\d{2}\*/m);
    });
}

// -----------------------------------------------------------------------------
// SR-1: no hay require dinámico — la whitelist es hardcoded
// -----------------------------------------------------------------------------

test('SR-1: dispatch rechaza nombres con path traversal sin tocar FS', async () => {
    // Estos nombres NO deben matchear ningún formatter y devolver help.
    const evilNames = [
        '../../../etc/passwd',
        '../report-secrets',
        'cuota; rm -rf',
        '../../skills-deterministicos/delivery',
    ];
    for (const name of evilNames) {
        const r = await reports.dispatch(name);
        assert.equal(r.kind, 'help', `${name} no debió matchear`);
    }
});

// -----------------------------------------------------------------------------
// splitMessage — partición de mensajes largos (CA-7)
// -----------------------------------------------------------------------------

test('splitMessage NO parte mensajes cortos', () => {
    const short = 'a\nb\nc';
    const r = reports.splitMessage(short);
    assert.equal(r.length, 1);
    assert.equal(r[0], short);
});

test('splitMessage parte mensajes >15 líneas (CA-7)', () => {
    // Generamos un mensaje con 30 bloques separados por línea en blanco para
    // que el splitter encuentre puntos de corte.
    const blocks = [];
    for (let i = 0; i < 30; i++) blocks.push(`bloque ${i}\ncontenido ${i}`);
    const text = blocks.join('\n\n');
    const r = reports.splitMessage(text);
    assert.ok(r.length > 1, 'debió partir en múltiples mensajes');
    // Cada chunk debe llevar prefix `*N/M*`.
    for (let i = 0; i < r.length; i++) {
        assert.match(r[i], new RegExp(`^\\*${i + 1}/${r.length}\\*`));
    }
});

test('splitMessage no rompe tablas (triple-backtick)', () => {
    // Tabla de 20 líneas entre fences ``` debe quedar en UN solo chunk.
    const tableLines = ['```'];
    for (let i = 0; i < 18; i++) tableLines.push(`row ${i}`);
    tableLines.push('```');
    const text = '*header*\n\n' + tableLines.join('\n') + '\n\nfooter';
    const r = reports.splitMessage(text);
    // Cualquier chunk que contenga la apertura ``` debe contener también el cierre.
    for (const chunk of r) {
        const opens = (chunk.match(/```/g) || []).length;
        assert.ok(opens % 2 === 0, `chunk con fence impar: ${chunk}`);
    }
});

// -----------------------------------------------------------------------------
// semaforoFromStatus — mapeo consistente (UX-1)
// -----------------------------------------------------------------------------

test('semaforoFromStatus mapea estados conocidos al unicode correcto', () => {
    assert.equal(reports.semaforoFromStatus('ok'), reports.SEMAFORO.OK);
    assert.equal(reports.semaforoFromStatus('normal'), reports.SEMAFORO.OK);
    assert.equal(reports.semaforoFromStatus('warning'), reports.SEMAFORO.WARN);
    assert.equal(reports.semaforoFromStatus('yellow'), reports.SEMAFORO.WARN);
    assert.equal(reports.semaforoFromStatus('alert'), reports.SEMAFORO.ALERT);
    assert.equal(reports.semaforoFromStatus('orange'), reports.SEMAFORO.ALERT);
    assert.equal(reports.semaforoFromStatus('critical'), reports.SEMAFORO.CRIT);
    assert.equal(reports.semaforoFromStatus('red'), reports.SEMAFORO.CRIT);
    assert.equal(reports.semaforoFromStatus('paused'), reports.SEMAFORO.PAUSE);
});

test('semaforoFromStatus es case-insensitive', () => {
    assert.equal(reports.semaforoFromStatus('OK'), reports.SEMAFORO.OK);
    assert.equal(reports.semaforoFromStatus('Critical'), reports.SEMAFORO.CRIT);
});

test('SEMAFORO está congelado (UX-1: constantes inmutables)', () => {
    assert.throws(() => { reports.SEMAFORO.OK = 'X'; });
});

// -----------------------------------------------------------------------------
// sanitizeError — SR-3: no exponer paths absolutos del SO
// -----------------------------------------------------------------------------

test('sanitizeError oculta path Windows con username', () => {
    const err = new Error('ENOENT: no such file: C:\\Users\\Administrator\\.pipeline\\foo.json');
    const out = reports.sanitizeError(err);
    assert.doesNotMatch(out, /Administrator/);
    assert.doesNotMatch(out, /C:\\Users/);
    assert.match(out, /<path>/);
});

test('sanitizeError oculta path Unix con username', () => {
    const err = new Error('open /home/leito/repo/.pipeline/foo');
    const out = reports.sanitizeError(err);
    assert.doesNotMatch(out, /leito/);
});

test('sanitizeError preserva mensaje sin paths', () => {
    const err = new Error('connection refused');
    const out = reports.sanitizeError(err);
    assert.match(out, /connection refused/);
});

// -----------------------------------------------------------------------------
// HELP_MENU — string canónico
// -----------------------------------------------------------------------------

test('HELP_MENU lista los 7 subcomandos válidos (CA-2 + UX-4)', () => {
    for (const section of reports.VALID_SECTIONS) {
        assert.match(reports.HELP_MENU, new RegExp(section), `falta ${section} en help`);
    }
});

test('HELP_MENU usa bloque triple-backtick (UX-4: tabla monospace)', () => {
    const fences = (reports.HELP_MENU.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, 'fences impares');
    assert.ok(fences >= 2, 'falta el bloque ```');
});

test('HELP_MENU incluye ejemplo de uso (UX-4)', () => {
    assert.match(reports.HELP_MENU, /Ejemplo:/);
});
