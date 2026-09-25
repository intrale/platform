'use strict';
// #7633 — Tests del export legible de la cadena de autoría (CA-2 · CA-3 · CA-4 · CA-5 · CA-9).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ec = require('../export-chain');
const labels = require('../labels-es');
const { REASON_COPY } = require('../copy');
const F = require('./fixtures/commits');

const NOW = new Date('2026-09-23T19:40:00Z');
const GH = 'https://github.com/intrale/platform/';
const XSS_1 = '<script>alert(1)</script>';
const XSS_2 = '"><img src=x onerror=alert(1)>';

function rangeHtml(extra = {}) {
    return ec.exportChain({ range: '4be07d9..9f3c2a1' }, {
        commits: F.MIXED_RANGE,
        titles: { 7593: { ok: true, title: XSS_1 }, 7630: { ok: true, title: XSS_2 } },
        goLiveDate: F.GO_LIVE,
        now: NOW,
        ...extra,
    });
}

function mainView(html) {
    return html.slice(0, html.indexOf('<h2>Anexo técnico</h2>'));
}

test('el HTML trae las 6 secciones U1 en orden', () => {
    const html = rangeHtml();
    const marks = [
        'class="doc-head"',
        '<strong>En resumen:</strong>',
        '<h2>La cadena de autoría, paso a paso</h2>',
        '<h2>Detalle de los cambios</h2>',
        '<h2>Qué prueba este documento y qué no</h2>',
        '<h2>Anexo técnico</h2>',
    ];
    const idx = marks.map((m) => html.indexOf(m));
    idx.forEach((i, k) => assert.ok(i >= 0, `falta la sección ${marks[k]}`));
    assert.deepStrictEqual([...idx].sort((a, b) => a - b), idx);
    assert.ok(html.includes('Constancia de dirección humana'));
    assert.ok(html.includes('Versión del formato: 1'));
    assert.ok(html.includes('Generado el <strong>23/09/2026, 16:40</strong> (hora de Argentina)'));
});

test('la cadena tiene exactamente 4 eslabones', () => {
    const html = rangeHtml();
    const chain = html.slice(html.indexOf('<ol class="chain">'), html.indexOf('</ol>'));
    assert.strictEqual((chain.match(/<li>/g) || []).length, 4);
});

test('#13: <script> y "><img onerror> en títulos salen escapados', () => {
    const html = rangeHtml();
    assert.ok(!/<script/i.test(html), 'no debe haber <script');
    assert.ok(!/<img/i.test(html), 'no debe haber <img');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
});

test('#14: sin chat_id, tokens ni paths del host (incluido el valor crudo fuera de allowlist)', () => {
    const html = rangeHtml();
    for (const bad of ['chat_id', 'ghp_', 'github_pat_', 'eyJ', 'C:\\', '/c/', '/home/', '/Users/']) {
        assert.ok(!html.includes(bad), `el export contiene ${bad}`);
    }
});

test('sin javascript:, data: en href, y todo href apunta al repo', () => {
    const html = rangeHtml();
    assert.ok(!/javascript:/i.test(html));
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0);
    for (const h of hrefs) assert.ok(h.startsWith(GH), `href fuera del repo: ${h}`);
});

test('mantiene la CSP del mockup', () => {
    const html = rangeHtml();
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`));
});

test('rango mixto ⇒ literal "1 de 5 cambios con firma" y un badge por estado', () => {
    const html = rangeHtml();
    assert.ok(html.includes('<strong>1 de 5 cambios con firma.</strong>'));
    assert.strictEqual((html.match(/badge ok/g) || []).length, 1);
    assert.strictEqual((html.match(/badge warn/g) || []).length, 3);
    assert.strictEqual((html.match(/badge bad/g) || []).length, 1);
    assert.ok(html.includes(labels.STATE_LABELS.signed));
    assert.ok(html.includes(labels.STATE_LABELS.unsigned));
    assert.ok(html.includes(labels.STATE_LABELS.invalid));
    assert.ok(html.includes(labels.UNSIGNED_REASONS['dry-run']));
    // go_live 2026-09-20T00:00Z = 19/09/2026 21:00 en hora de Argentina.
    assert.ok(html.includes('Cambio anterior a la entrada en vigencia del registro de firma (19/09/2026).'));
    assert.ok(html.includes(labels.UNSIGNED_REASONS.unrecognized));
    assert.ok(html.includes(labels.INVALID_REASON));
});

test('modelo: sólo el firmado suma a X', () => {
    const m = ec.buildChainModel({ scope: { range: 'a..b' }, commits: F.MIXED_RANGE, goLiveDate: F.GO_LIVE, now: NOW });
    assert.deepStrictEqual(m.count, { signed: 1, unsigned: 3, invalid: 1, total: 5 });
    assert.deepStrictEqual(m.items.map((i) => [i.state, i.reason]), [
        ['signed', null],
        ['unsigned', 'dry-run'],
        ['unsigned', 'pre-go-live'],
        ['invalid', null],
        ['unsigned', 'unrecognized'],
    ]);
});

test('tarjeta firmada: operador, decisión U2 con hora de Argentina y huella acortada', () => {
    const html = rangeHtml();
    assert.ok(html.includes('<span class="mono">leitolarreta</span> (operador)'));
    assert.ok(html.includes('Firmó la aceptación del código · 23/09/2026 16:12 (hora de Argentina)'));
    assert.ok(html.includes('sha256:ab12cd34ef56…'));
    assert.ok(html.includes('Anthropic claude-opus-5-5 — escribió el código<br>OpenAI gpt-5-codex — revisó el código'));
    assert.ok(html.includes(`<a href="${GH}pull/7650">#7650</a>`));
    assert.ok(html.includes(`${GH}commit/${'9'.repeat(40)}`));
});

test('la leyenda de "qué no prueba" está aun con 0 firmados', () => {
    const html = ec.exportChain({ range: 'a1b2c3d..HEAD' }, { commits: [F.NO_BLOCK_POST], now: NOW });
    assert.ok(html.includes('<strong>0 de 1 cambios con firma.</strong>'));
    assert.ok(html.includes('Esta constancia verifica la consistencia de los registros en <span class="mono">main</span>; no prueba por sí sola la autenticidad de la firma.'));
});

test('también con alcance vacío hay leyenda y "0 de 0"', () => {
    const html = ec.exportChain({ range: 'a1b2c3d..HEAD' }, { commits: [], now: NOW });
    assert.ok(html.includes('0 de 0 cambios con firma'));
    assert.ok(html.includes('no prueba por sí sola la autenticidad de la firma'));
    assert.ok(html.includes('No hay cambios en este alcance.'));
});

test('claves técnicas y horas UTC sólo en el anexo; hash completo en el anexo', () => {
    const html = rangeHtml();
    const main = mainView(html);
    assert.ok(!/intrale-/i.test(main), 'clave técnica fuera del anexo');
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(main), 'hora ISO fuera del anexo');
    const annex = html.slice(html.indexOf('<h2>Anexo técnico</h2>'));
    assert.ok(annex.includes(`Intrale-Human-Direction: leitolarreta; 2026-09-23T19:12:00Z; gate2:sha256:${F.HASH}`));
    assert.ok(annex.includes('9'.repeat(40)));
    assert.ok(annex.includes('sin bloque de autoría · 2026-09-21T14:03:10Z'), 'fecha del anexo en UTC');
    assert.ok(annex.includes('bloque de autoría inválido: clave duplicada: Intrale-Human-Direction'));
    assert.ok(annex.includes('(no transcripto)'));
});

test('CA-4: el valor fuera de allowlist nunca se muestra, ni escapado', () => {
    const html = ec.exportChain({ range: 'a1b2c3d..HEAD' }, { commits: [F.OUT_OF_ALLOWLIST], now: NOW });
    assert.ok(!html.includes('alert(1)'));
    assert.ok(!html.includes('ghp_'));
    assert.ok(html.includes(labels.UNSIGNED_REASONS.unrecognized));
});

test('CA-4: clave fuera del último párrafo ⇒ trailer inválido que no suma', () => {
    const m = ec.buildChainModel({ scope: { range: 'a..b' }, commits: [F.OUT_OF_BLOCK, F.SIGNED], now: NOW });
    assert.strictEqual(m.items[0].state, 'invalid');
    assert.deepStrictEqual([m.count.signed, m.count.total], [1, 2]);
});

test('P1: bloque válido con none; …; missing ⇒ sin firma con el motivo del trailer', () => {
    const m = ec.buildChainModel({ scope: { range: 'a..b' }, commits: [F.NONE_MISSING], now: NOW });
    assert.strictEqual(m.items[0].state, 'unsigned');
    assert.strictEqual(m.items[0].reason, 'missing');
    const html = ec.renderChainHtml(m);
    assert.ok(html.includes(REASON_COPY.missing));
    assert.ok(html.includes('Anthropic claude-opus-4-7 — escribió el código'));
});

test('D-0/N: con 0 firmados sin inválidos aparece la nota de modo de prueba', () => {
    const html = ec.exportChain({ range: 'a1b2c3d..HEAD' }, { commits: [F.NONE_MISSING, F.NO_BLOCK_POST, F.NO_BLOCK_PRE], goLiveDate: F.GO_LIVE, now: NOW });
    assert.ok(html.includes(labels.ZERO_OF_N_NOTE));
    assert.ok(html.includes('Ningún cambio tiene registrada la firma'));
});

test('D-0/N: la nota no aparece si hay inválidos, datos no reconocidos o firmados', () => {
    for (const commits of [[F.DUPLICATE], [F.OUT_OF_ALLOWLIST], [F.SIGNED], []]) {
        const html = ec.exportChain({ range: 'a1b2c3d..HEAD' }, { commits, now: NOW });
        assert.ok(!html.includes(labels.ZERO_OF_N_NOTE));
    }
});

test('export de un PR sin firma ⇒ "0 de 1" con motivo y cadena detallada', () => {
    const html = ec.exportChain({ pr: 7651 }, {
        commits: [F.NONE_MISSING],
        titles: { 7631: 'Trailer de autoría normalizado' },
        now: NOW,
    });
    assert.ok(html.includes('mediante el Pull Request <strong>#7651</strong>'));
    assert.ok(html.includes('<strong>0 de 1 cambios con firma.</strong>'));
    assert.ok(html.includes('No hay una firma del operador registrada para este cambio.'));
    assert.ok(html.includes('#7631 — Trailer de autoría normalizado'));
    assert.ok(html.includes('<h2>Detalle del cambio</h2>'));
    assert.ok(html.includes('<div class="n">Sin firma registrada</div>'));
    assert.ok(html.includes('<title>Constancia de dirección humana — PR #7651</title>'));
});

test('export de un PR firmado ⇒ "1 de 1" y el login en la cadena', () => {
    const html = ec.exportChain({ pr: 7650 }, { commits: [F.SIGNED], titles: { 7593: 'Trazabilidad' }, now: NOW });
    assert.ok(html.includes('<strong>1 de 1 cambios con firma.</strong>'));
    assert.ok(html.includes('bajo la dirección de una persona'));
    assert.ok(html.includes('<strong>leitolarreta</strong> (operador) firmó la aceptación del código el <strong>23/09/2026 a las 16:12</strong>'));
    assert.ok(html.includes('<div class="n">2</div><div class="l">Herramientas de IA que asistieron</div>'));
});

test('título que no se pudo obtener ⇒ mensaje genérico, sin detalle', () => {
    const html = ec.exportChain({ pr: 7650 }, {
        commits: [F.SIGNED],
        titles: { 7593: { ok: false, publicMessage: 'C:\\Users\\x ghp_abc' } },
        now: NOW,
    });
    assert.ok(html.includes('#7593 (no se pudo obtener el título de #7593)'));
    assert.ok(!html.includes('ghp_'));
});

test('rol desconocido: escapado una sola vez en el renderer', () => {
    const m = ec.buildChainModel({ scope: { range: 'a..b' }, commits: [F.SIGNED], now: NOW });
    m.items[0].ai = [{ provider: 'anthropic', model: 'x', role: '<x>' }];
    const html = ec.renderChainHtml(m);
    assert.ok(html.includes('asistió (&lt;x&gt;)'));
    assert.ok(!html.includes('&amp;lt;'));
});

test('commit con sha ilegible no genera link', () => {
    const html = ec.exportChain({ range: 'a1b2c3d..HEAD' }, { commits: [{ ...F.NO_BLOCK_POST, sha: 'zzz' }], now: NOW });
    assert.ok(html.includes('(registro no legible)'));
    assert.ok(!html.includes('/commit/'));
});

test('commit sin número de tarea en el bloque ⇒ inválido', () => {
    const msg = F.SIGNED.message.replace('Closes #7593\n', '').replace('Intrale-Issue: #7593\n', '');
    const m = ec.buildChainModel({ scope: { range: 'a..b' }, commits: [{ ...F.SIGNED, message: msg }], now: NOW });
    assert.strictEqual(m.items[0].state, 'invalid');
});

test('sin go_live_date un commit sin bloque cuenta como modo de prueba', () => {
    const m = ec.buildChainModel({ scope: { range: 'a..b' }, commits: [F.NO_BLOCK_PRE], goLiveDate: 'no-es-fecha', now: NOW });
    assert.strictEqual(m.items[0].reason, 'dry-run');
    assert.strictEqual(m.goLiveDate, null);
});

test('issuesOf devuelve las tareas de los bloques legibles, sin repetir', () => {
    assert.deepStrictEqual(ec.issuesOf([F.SIGNED, F.SIGNED, F.NONE_MISSING, F.NO_BLOCK_POST, F.DUPLICATE]).sort(), [7593, 7631]);
    assert.deepStrictEqual(ec.issuesOf(null), []);
});

test('alcance inválido lanza', () => {
    assert.throws(() => ec.exportChain({}, { commits: [] }), /alcance inválido/);
    assert.throws(() => ec.exportChain({ pr: -1 }, { commits: [] }), /alcance inválido/);
});

test('links: sólo números y SHA validados', () => {
    assert.strictEqual(ec.prHref(12), `${GH}pull/12`);
    assert.strictEqual(ec.issueHref(3), `${GH}issues/3`);
    assert.throws(() => ec.prHref('12'), /pr inválido/);
    assert.throws(() => ec.issueHref(0), /issue inválido/);
    assert.throws(() => ec.commitHref('javascript:alert(1)'), /sha inválido/);
});

test('fechas en hora de Argentina', () => {
    assert.strictEqual(ec.formatArDateTime('2026-09-23T19:12:00Z'), '23/09/2026 16:12');
    assert.strictEqual(ec.formatArDate('2026-09-24T01:00:00Z'), '23/09/2026');
    assert.strictEqual(ec.formatArDateTime('no'), '');
});

test('estático: export-chain.js no define el formato del trailer ni hace I/O', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'export-chain.js'), 'utf8');
    assert.ok(!/intrale-/i.test(src), 'export-chain.js no debe nombrar claves Intrale-*');
    for (const mod of ['fs', 'child_process', 'https', 'http', 'net', 'puppeteer']) {
        assert.ok(!new RegExp(`require\\(['"](node:)?${mod}['"]\\)`).test(src), `export-chain.js requiere ${mod}`);
    }
    assert.ok(src.includes("require('./trailer')"));
});
