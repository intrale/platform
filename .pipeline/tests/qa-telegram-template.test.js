// =============================================================================
// qa-telegram-template.test.js — Unit tests del template Telegram del QA (#2519)
//
// Ejecución: `node .pipeline/tests/qa-telegram-template.test.js`
// Sin dependencias externas — runner mínimo alineado con los otros tests del
// pipeline (sanitizer.test.js, sanitize-payload.test.js).
//
// Cubre los criterios de aceptación del issue #2519:
//   - 6 paths visuales (3 modos × 2 veredictos) — CA-A1, CA-A6, CA-A8
//   - Payload legacy sin verdict — CA-B1
//   - Escape Markdown contra title/motivo maliciosos — CA-S1
//   - Validación de enums (verdict/mode/provider) — CA-S3
//   - Validación de issue numérico — CA-S4
//   - Strip de control chars — CA-S5
//   - Truncado multibyte-safe (title 80, motivo 500) — CA-S6, CA-A3
//   - Redacción de secretos (JWT, AWS) — CA-S7
// =============================================================================
'use strict';

const assert = require('assert');
const path = require('path');

const modPath = path.join(__dirname, '..', '..', 'qa', 'scripts', 'qa-telegram-template.js');
const {
    buildTelegramMessage,
    escapeMarkdown,
    stripControl,
    truncate,
    redactSecrets,
    sanitizeFreeText,
    resolveVerdict,
    resolveMode,
    resolveNarrator,
    parseCount,
    isValidIssue,
    isSafeRelPath,
} = require(modPath);

// ─── Runner minimal ─────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
    let passed = 0; let failed = 0; const errors = [];
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log(`  + ${t.name}`);
        } catch (e) {
            failed++;
            errors.push({ name: t.name, err: e });
            console.log(`  x ${t.name}`);
            console.log(`     ${e && e.message}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
    if (failed > 0) {
        for (const e of errors) {
            console.log(`\n--- FAIL: ${e.name} ---`);
            console.log(e.err && e.err.stack || e.err);
        }
        process.exit(1);
    }
}

// ─── Helpers puros ──────────────────────────────────────────────────────────

test('escapeMarkdown escapa _, *, [, ], `, (, )', () => {
    const input = 'foo_bar *baz* [link](http://x) `code`';
    const out = escapeMarkdown(input);
    assert.ok(out.includes('\\_'), 'escapa _');
    assert.ok(out.includes('\\*'), 'escapa *');
    assert.ok(out.includes('\\['), 'escapa [');
    assert.ok(out.includes('\\]'), 'escapa ]');
    assert.ok(out.includes('\\`'), 'escapa backtick');
    assert.ok(out.includes('\\('), 'escapa (');
    assert.ok(out.includes('\\)'), 'escapa )');
});

test('escapeMarkdown no rompe con input no-string', () => {
    assert.strictEqual(escapeMarkdown(null), '');
    assert.strictEqual(escapeMarkdown(undefined), '');
    assert.strictEqual(escapeMarkdown(123), '');
});

test('stripControl elimina null bytes, ANSI y CR', () => {
    const input = 'hola\x00\x1b[31mrojo\x1b[0m\r\nfin';
    const out = stripControl(input);
    assert.ok(!out.includes('\x00'), 'sin null byte');
    assert.ok(!out.includes('\x1b'), 'sin ESC');
    assert.ok(!out.includes('\r'), 'sin CR');
    assert.ok(out.includes('hola'), 'preserva texto');
    assert.ok(out.includes('rojo'), 'preserva texto entre ANSI');
});

test('truncate respeta code points multibyte', () => {
    const input = 'a'.repeat(5) + '😀'.repeat(3); // 5 + 3 emojis
    const out = truncate(input, 6);
    // Array.from cuenta cada emoji como 1 → debería quedar "aaaaa" + 1 emoji + elipsis
    assert.strictEqual(Array.from(out.replace(/…$/, '')).length, 6);
    assert.ok(out.endsWith('…'), 'agrega elipsis');
});

test('truncate no corta si está bajo el máximo', () => {
    assert.strictEqual(truncate('hola', 10), 'hola');
    assert.strictEqual(truncate('', 10), '');
});

test('redactSecrets redacta JWT', () => {
    const input = 'Error en token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_def-ghi al llamar';
    const out = redactSecrets(input);
    assert.ok(out.includes('[REDACTED]'), 'reemplaza con placeholder');
    assert.ok(!/eyJhbGciOiJIUzI1NiJ9\./.test(out), 'el JWT ya no aparece');
});

test('redactSecrets redacta AWS access key', () => {
    const input = 'Falla con AKIAIOSFODNN7EXAMPLE en request';
    const out = redactSecrets(input);
    assert.ok(out.includes('[REDACTED]'));
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('redactSecrets redacta token en query string', () => {
    const input = 'Falla llamando https://foo?token=AKIA1234567890ABCDEF0123 status 500';
    const out = redactSecrets(input);
    assert.ok(out.includes('[REDACTED]'));
});

test('resolveVerdict acepta aprobado/rechazado case-insensitive', () => {
    assert.strictEqual(resolveVerdict('aprobado').approved, true);
    assert.strictEqual(resolveVerdict('APROBADO').approved, true);
    assert.strictEqual(resolveVerdict('Aprobado').approved, true);
    assert.strictEqual(resolveVerdict('rechazado').approved, false);
    assert.strictEqual(resolveVerdict('RECHAZADO').approved, false);
});

test('resolveVerdict devuelve null para valores fuera de set', () => {
    assert.strictEqual(resolveVerdict('EVIDENCIA'), null);
    assert.strictEqual(resolveVerdict(''), null);
    assert.strictEqual(resolveVerdict(null), null);
    assert.strictEqual(resolveVerdict(123), null);
});

test('resolveMode acepta android/api/structural', () => {
    assert.strictEqual(resolveMode('android').key, 'android');
    assert.strictEqual(resolveMode('api').key, 'api');
    assert.strictEqual(resolveMode('structural').key, 'structural');
});

test('resolveMode rechaza valores fuera de set', () => {
    assert.strictEqual(resolveMode('ios'), null);
    assert.strictEqual(resolveMode(''), null);
});

test('resolveNarrator mapea edge→Nacho y openai→Rulo', () => {
    assert.strictEqual(resolveNarrator('edge'), 'Nacho');
    assert.strictEqual(resolveNarrator('openai'), 'Rulo');
    assert.strictEqual(resolveNarrator('EDGE'), 'Nacho');
    assert.strictEqual(resolveNarrator('azure'), null);
    assert.strictEqual(resolveNarrator(''), null);
});

test('parseCount parsea enteros no negativos', () => {
    assert.strictEqual(parseCount('5'), 5);
    assert.strictEqual(parseCount(10), 10);
    assert.strictEqual(parseCount('-3'), 0);
    assert.strictEqual(parseCount('abc'), 0);
    assert.strictEqual(parseCount(null), 0);
    assert.strictEqual(parseCount(undefined), 0);
});

test('isValidIssue requiere dígitos positivos', () => {
    assert.strictEqual(isValidIssue('2519'), true);
    assert.strictEqual(isValidIssue(2519), true);
    assert.strictEqual(isValidIssue('../etc/passwd'), false);
    assert.strictEqual(isValidIssue(''), false);
    assert.strictEqual(isValidIssue('abc'), false);
});

test('isSafeRelPath bloquea `..` y absolutos', () => {
    assert.strictEqual(isSafeRelPath('logs/rejection-2519-qa.pdf'), true);
    assert.strictEqual(isSafeRelPath('../../../etc/passwd'), false);
    assert.strictEqual(isSafeRelPath('/absolute/path'), false);
    assert.strictEqual(isSafeRelPath('C:/windows/path'), false);
    assert.strictEqual(isSafeRelPath(''), false);
});

// ─── Template: 6 paths (3 modos × 2 veredictos) ─────────────────────────────

test('path aprobado-android incluye ícono ✅, título, tests y modo', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'feat(app): icono por flavor',
        verdict: 'aprobado',
        passed: 5,
        total: 5,
        mode: 'android',
        narratorProvider: 'edge',
        driveLink: 'https://drive.google.com/abc',
        reportPath: 'qa/evidence/2519/qa-report.json',
        timestamp: '16:36',
    });
    assert.ok(msg.includes('*QA APROBADO*'), 'header aprobado');
    assert.ok(msg.includes('#2519'), 'número de issue');
    // title es escapado: `(` y `)` van precedidos por backslash para que Telegram
    // no interprete como link markdown. Verificamos la parte textual intacta.
    assert.ok(msg.includes('icono por flavor'), 'título visible');
    assert.ok(msg.includes('\\('), 'paréntesis escapados');
    assert.ok(msg.includes('5/5 criterios verificados'), 'tests correctos');
    assert.ok(msg.includes('android (emulador + video)'), 'modo android');
    assert.ok(msg.includes('Nacho'), 'narrador edge → Nacho');
    assert.ok(msg.includes('16:36'), 'timestamp HH:MM');
    assert.ok(msg.includes('drive.google.com/abc'), 'link drive');
    assert.ok(msg.includes('qa-report.json'), 'path report');
});

test('path rechazado-android incluye motivo + criterios + rejection PDF', () => {
    // Crear PDF fake para que isSafeRelPath + existencia pasen
    // Usamos path que isSafeRelPath acepta; en el módulo puro no validamos existencia.
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'bug: login falla',
        verdict: 'rechazado',
        passed: 2,
        total: 5,
        mode: 'android',
        motivo: 'Los 3 flavors muestran iconos visualmente identicos.',
        criteriosFallidos: ['CA-1', 'CA-4', 'CA-5'],
        narratorProvider: 'openai',
        rejectionPdf: 'logs/rejection-2519-qa.pdf',
        driveLink: 'https://drive.google.com/xyz',
        reportPath: 'qa/evidence/2519/qa-report.json',
        timestamp: '17:00',
    });
    assert.ok(msg.includes('*QA RECHAZADO*'), 'header rechazado');
    assert.ok(msg.includes('2/5 criterios verificados'), 'contadores reales');
    assert.ok(msg.includes('Motivo:'), 'sección motivo');
    assert.ok(msg.includes('iconos visualmente identicos'), 'texto motivo (sin acentos)');
    assert.ok(msg.includes('Criterios fallidos:'), 'sección criterios');
    assert.ok(msg.includes('CA-1'), 'listado de criterios');
    assert.ok(msg.includes('CA-4'), 'listado de criterios');
    assert.ok(msg.includes('Rulo'), 'narrador openai → Rulo');
    assert.ok(msg.includes('logs/rejection-2519-qa.pdf'), 'rejection PDF linkeado');
});

test('path aprobado-api usa "Test cases" y "pasaron"', () => {
    const msg = buildTelegramMessage({
        issue: '2463',
        title: '[Split] cross-tenant guard en SecuredFunction',
        verdict: 'aprobado',
        passed: 7,
        total: 7,
        mode: 'api',
        narratorProvider: 'edge',
        reportPath: 'qa/evidence/2463/qa-api-report.json',
        timestamp: '12:18',
    });
    assert.ok(msg.includes('*QA APROBADO*'));
    assert.ok(msg.includes('7/7 pasaron'), 'label api');
    assert.ok(msg.includes('Test cases'), 'label Test cases');
    assert.ok(msg.includes('api (sin video)'), 'modo api visible');
});

test('path rechazado-api muestra motivo y omite rejection-pdf si no se pasa', () => {
    const msg = buildTelegramMessage({
        issue: '2463',
        title: 'backend: validación',
        verdict: 'rechazado',
        passed: 4,
        total: 7,
        mode: 'api',
        motivo: 'TC-03 devuelve 200 cuando debería ser 403.',
        criteriosFallidos: ['TC-03'],
        reportPath: 'qa/evidence/2463/qa-api-report.json',
        timestamp: '12:30',
    });
    assert.ok(msg.includes('*QA RECHAZADO*'));
    assert.ok(msg.includes('4/7 pasaron'));
    assert.ok(msg.includes('TC-03'));
    assert.ok(!msg.includes('Rejection report:'), 'sin rejectionPdf → sin línea PDF');
});

test('path aprobado-structural breve sin video', () => {
    const msg = buildTelegramMessage({
        issue: '2100',
        title: 'docs: agregar sección X',
        verdict: 'aprobado',
        passed: 3,
        total: 3,
        mode: 'structural',
        narratorProvider: 'edge',
        reportPath: 'qa/evidence/2100/qa-report.json',
        timestamp: '09:45',
    });
    assert.ok(msg.includes('*QA APROBADO*'));
    assert.ok(msg.includes('structural (audit rápido)'));
    assert.ok(msg.includes('3/3 criterios verificados'));
});

test('path rechazado-structural con criterios masivos hace truncado a 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => 'CA-' + (i + 1));
    const msg = buildTelegramMessage({
        issue: '2100',
        title: 'docs',
        verdict: 'rechazado',
        passed: 0,
        total: 15,
        mode: 'structural',
        motivo: 'falla masiva',
        criteriosFallidos: many,
        timestamp: '10:00',
    });
    assert.ok(msg.includes('*QA RECHAZADO*'));
    // Debe listar 10 + indicar "+5 más"
    assert.ok(msg.includes('CA-1'));
    assert.ok(msg.includes('CA-10'));
    assert.ok(msg.includes('+5 más'), 'indica criterios extra');
    assert.ok(!msg.includes('CA-15'), 'no lista criterios sobrantes');
});

// ─── CA-B1: payload legacy ──────────────────────────────────────────────────

test('path legacy (sin verdict) usa header neutro 📹', () => {
    const msg = buildTelegramMessage({
        issue: '1234',
        title: 'legacy issue',
        // verdict ausente
        driveLink: 'https://drive.google.com/legacy',
        reportPath: 'qa/evidence/1234/qa-report.json',
        timestamp: '08:00',
    });
    assert.ok(!msg.includes('APROBADO'), 'no afirma aprobado');
    assert.ok(!msg.includes('RECHAZADO'), 'no afirma rechazado');
    assert.ok(msg.includes('#1234'));
    assert.ok(msg.includes('drive.google.com/legacy'));
});

test('path legacy no crashea con payload vacío', () => {
    const msg = buildTelegramMessage({ issue: '1234' });
    assert.ok(typeof msg === 'string');
    assert.ok(msg.includes('#1234'));
});

// ─── CA-S1: escape de Markdown malicioso ────────────────────────────────────

test('title con link malicioso queda escapado', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'fix: algo [click](http://evil)',
        verdict: 'aprobado',
        passed: 1,
        total: 1,
        mode: 'android',
        timestamp: '10:00',
    });
    // El link completo NO debe aparecer como hyperlink Markdown válido
    assert.ok(!msg.includes('[click](http://evil)'), 'link malicioso fue escapado');
    assert.ok(msg.includes('\\['), 'brackets escapados');
    assert.ok(msg.includes('\\]'));
    assert.ok(msg.includes('\\('));
    assert.ok(msg.includes('\\)'));
});

test('motivo con asteriscos maliciosos se escapa', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'rechazado',
        passed: 0,
        total: 1,
        mode: 'android',
        motivo: 'falla en *lib* crítica',
        timestamp: '10:00',
    });
    assert.ok(msg.includes('\\*lib\\*') || msg.includes('\\*lib\\\\*'), 'asteriscos escapados');
});

// ─── CA-S7: redacción de secretos en motivo ─────────────────────────────────

test('motivo con JWT se redacta antes de enviarlo', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'rechazado',
        passed: 0,
        total: 1,
        mode: 'android',
        motivo: 'Auth falla con token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_def-ghi123',
        timestamp: '10:00',
    });
    // Después de redact + escape Markdown, los brackets quedan escapados.
    assert.ok(msg.includes('REDACTED'), 'placeholder REDACTED presente');
    assert.ok(msg.includes('\\[REDACTED\\]') || msg.includes('[REDACTED]'), 'forma [REDACTED] visible');
    assert.ok(!msg.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT no aparece en el mensaje');
});

test('motivo con AWS key se redacta', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'rechazado',
        passed: 0,
        total: 1,
        mode: 'android',
        motivo: 'AWS error AKIAIOSFODNN7EXAMPLE',
        timestamp: '10:00',
    });
    assert.ok(msg.includes('REDACTED'));
    assert.ok(!msg.includes('AKIAIOSFODNN7EXAMPLE'));
});

// ─── CA-S3: validación de enums ─────────────────────────────────────────────

test('verdict desconocido cae a path legacy (icono neutro)', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'EVIDENCIA', // inválido
        passed: 0,
        total: 0,
        mode: 'android',
        timestamp: '10:00',
    });
    assert.ok(!msg.includes('*QA APROBADO*'));
    assert.ok(!msg.includes('*QA RECHAZADO*'));
});

test('mode desconocido cae a indeterminado', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'aprobado',
        passed: 1,
        total: 1,
        mode: 'desktop', // inválido
        timestamp: '10:00',
    });
    assert.ok(msg.includes('indeterminado'), 'modo fallback explícito');
});

test('provider desconocido omite línea del narrador', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'aprobado',
        passed: 1,
        total: 1,
        mode: 'android',
        narratorProvider: 'azure', // inválido
        timestamp: '10:00',
    });
    assert.ok(!msg.includes('Narrado por'), 'no afirma narrador');
    assert.ok(msg.includes('10:00'), 'timestamp aún aparece');
});

// ─── CA-S4: validación de issue ─────────────────────────────────────────────

test('issue no numérico no construye mensaje con datos', () => {
    const msg = buildTelegramMessage({
        issue: '../../../etc/passwd',
        title: 'x',
        verdict: 'aprobado',
        passed: 1,
        total: 1,
        mode: 'android',
        timestamp: '10:00',
    });
    assert.ok(!msg.includes('../'));
    assert.ok(!msg.includes('/etc/passwd'));
    assert.ok(msg.includes('inválido'), 'mensaje genérico');
});

// ─── CA-A3/S6: truncado de título ───────────────────────────────────────────

test('title >80 chars se trunca con elipsis', () => {
    const longTitle = 'x'.repeat(120);
    const msg = buildTelegramMessage({
        issue: '2519',
        title: longTitle,
        verdict: 'aprobado',
        passed: 1,
        total: 1,
        mode: 'android',
        timestamp: '10:00',
    });
    const line = msg.split('\n').find((l) => l.startsWith('_x'));
    assert.ok(line, 'hay línea de título');
    // 80 chars + elipsis + wrapper itálico
    assert.ok(line.endsWith('…_') || line.endsWith('…_'), 'termina en elipsis');
});

// ─── CA-A5: edge case total=0 ───────────────────────────────────────────────

test('total=0 aprobado muestra "sin criterios cuantificados"', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'aprobado',
        passed: 0,
        total: 0,
        mode: 'structural',
        timestamp: '10:00',
    });
    assert.ok(msg.includes('sin criterios cuantificados'));
});

test('total=0 rechazado muestra "rechazado sin tests ejecutados"', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'rechazado',
        passed: 0,
        total: 0,
        mode: 'structural',
        motivo: 'aborto',
        timestamp: '10:00',
    });
    assert.ok(msg.includes('rechazado sin tests ejecutados'));
});

// ─── CA-S3 passed > total → clamp ───────────────────────────────────────────

test('passed > total se recorta a total', () => {
    const msg = buildTelegramMessage({
        issue: '2519',
        title: 'x',
        verdict: 'aprobado',
        passed: 99,
        total: 5,
        mode: 'android',
        timestamp: '10:00',
    });
    assert.ok(msg.includes('5/5'), 'passed clampeado a total');
    assert.ok(!msg.includes('99/5'));
});

// ─── Correr ─────────────────────────────────────────────────────────────────

runAll();
