'use strict';

// Tests del helper de entregables físicos (EP3-H3 / #3929).
// Cubren los CA de seguridad: CA-5 (path traversal), CA-6 (redacción de
// secrets), CA-8 (sanitización SVG/XXE) y la resolución de dir desde
// SKILL_SOURCES.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    writeDeliverable,
    resolveDeliverableDir,
    sanitizeSvg,
    redactContent,
} = require('./write-deliverable');

// Root temporal aislado por corrida — no toca el FS real del pipeline.
function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
}

// -----------------------------------------------------------------------------
// CA-5 — path traversal en `issue`
// -----------------------------------------------------------------------------

test('resolveDeliverableDir rechaza issue no numérico', () => {
    assert.throws(() => resolveDeliverableDir('guru', 'abc'), /issue inválido/);
});

test('resolveDeliverableDir rechaza issue con ".."', () => {
    assert.throws(() => resolveDeliverableDir('guru', '..'), /issue inválido/);
    assert.throws(() => resolveDeliverableDir('guru', '../../etc'), /issue inválido/);
});

test('resolveDeliverableDir rechaza issue con separador "/"', () => {
    assert.throws(() => resolveDeliverableDir('guru', '12/34'), /issue inválido/);
    assert.throws(() => resolveDeliverableDir('guru', '1/../2'), /issue inválido/);
});

test('writeDeliverable propaga el rechazo de issue inválido', () => {
    assert.throws(
        () => writeDeliverable('guru', '../evil', { md: 'x', pipelineRoot: tmpRoot() }),
        /issue inválido/,
    );
});

// -----------------------------------------------------------------------------
// Resolución de dir desde SKILL_SOURCES (sin hardcode)
// -----------------------------------------------------------------------------

test('resolveDeliverableDir resuelve el dir issue-scoped correcto por skill', () => {
    const root = tmpRoot();
    const guruDir = resolveDeliverableDir('guru', '3929', { ext: '.md', pipelineRoot: root });
    assert.ok(
        guruDir.replace(/\\/g, '/').endsWith('.pipeline/assets/docs/3929'),
        `guru → docs/{issue}: ${guruDir}`,
    );

    const uxDir = resolveDeliverableDir('ux', '3929', { pipelineRoot: root });
    assert.ok(
        uxDir.replace(/\\/g, '/').endsWith('.pipeline/assets/mockups/3929'),
        `ux → mockups/{issue}: ${uxDir}`,
    );

    const qaDir = resolveDeliverableDir('qa', '3929', { ext: '.md', pipelineRoot: root });
    assert.ok(
        qaDir.replace(/\\/g, '/').endsWith('.pipeline/assets/docs/3929'),
        `qa reporte → docs/{issue}: ${qaDir}`,
    );
});

test('resolveDeliverableDir rechaza skill sin perfil', () => {
    assert.throws(() => resolveDeliverableDir('inexistente', '1'), /skill sin perfil/);
});

test('cua no tiene doctrina de helper (canal aparte) pero igual resuelve issue-scoped', () => {
    // cua usa .pipeline/cua-outputs/{issue}; sigue siendo issue-scoped.
    const dir = resolveDeliverableDir('cua', '7', { pipelineRoot: tmpRoot() });
    assert.ok(dir.replace(/\\/g, '/').endsWith('.pipeline/cua-outputs/7'));
});

// -----------------------------------------------------------------------------
// CA-6 — redacción de secrets
// -----------------------------------------------------------------------------

test('redactContent redacta AWS access key', () => {
    const out = redactContent('clave: AKIAIOSFODNN7EXAMPLE en el reporte');
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), `no debe filtrar AWS key: ${out}`);
});

test('redactContent redacta JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF123_-signature';
    const out = redactContent(`token=${jwt}`);
    assert.ok(!out.includes(jwt), `no debe filtrar JWT: ${out}`);
});

test('writeDeliverable redacta secrets en el archivo persistido (CA-6)', () => {
    const root = tmpRoot();
    const { path: file } = writeDeliverable('guru', '100', {
        md: 'Analisis\nAWS=AKIAIOSFODNN7EXAMPLE\nfin',
        pipelineRoot: root,
    });
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(!written.includes('AKIAIOSFODNN7EXAMPLE'), `archivo no debe contener la key: ${written}`);
});

test('writeDeliverable con redact:false NO redacta', () => {
    const root = tmpRoot();
    const { path: file } = writeDeliverable('guru', '101', {
        md: 'literal AKIAIOSFODNN7EXAMPLE',
        redact: false,
        pipelineRoot: root,
    });
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.includes('AKIAIOSFODNN7EXAMPLE'));
});

// -----------------------------------------------------------------------------
// CA-8 — sanitización SVG (XSS/XXE)
// -----------------------------------------------------------------------------

test('sanitizeSvg elimina <script>', () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>');
    assert.ok(!/script/i.test(out), out);
    assert.ok(out.includes('<rect/>'));
});

test('sanitizeSvg elimina handlers on*', () => {
    const out = sanitizeSvg('<svg><rect onload="x()" onclick=\'y()\'/></svg>');
    assert.ok(!/onload/i.test(out) && !/onclick/i.test(out), out);
});

test('sanitizeSvg elimina <!DOCTYPE> y <!ENTITY> (XXE)', () => {
    const payload =
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>';
    const out = sanitizeSvg(payload);
    assert.ok(!/<!DOCTYPE/i.test(out), out);
    assert.ok(!/<!ENTITY/i.test(out), out);
    assert.ok(!/SYSTEM/i.test(out), out);
});

test('sanitizeSvg elimina URIs javascript:', () => {
    const out = sanitizeSvg('<svg><a href="javascript:alert(1)">x</a></svg>');
    assert.ok(!/javascript:/i.test(out), out);
});

test('writeDeliverable sanitiza SVG y escribe .svg en mockups (ux)', () => {
    const root = tmpRoot();
    const { path: file } = writeDeliverable('ux', '200', {
        svg: '<svg><script>evil()</script><circle r="5"/></svg>',
        pipelineRoot: root,
    });
    assert.ok(file.endsWith('.svg'), file);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(!/script/i.test(written), written);
    assert.ok(written.includes('<circle r="5"/>'));
});

// -----------------------------------------------------------------------------
// Escritura: crea el archivo en el root issue-scoped
// -----------------------------------------------------------------------------

test('writeDeliverable crea el archivo en el root issue-scoped y devuelve {path,bytes}', () => {
    const root = tmpRoot();
    const res = writeDeliverable('tester', '321', { md: '# cobertura\n90%' });
    // Sin pipelineRoot explícito usa cwd; verificamos contra cwd.
    assert.ok(typeof res.path === 'string' && res.path.length > 0);
    assert.ok(res.bytes > 0);
    // Cleanup: borrar archivo + dir issue-scoped creado bajo cwd.
    fs.rmSync(path.dirname(res.path), { recursive: true, force: true });

    // Con pipelineRoot explícito: verificación determinística.
    const res2 = writeDeliverable('tester', '321', { md: '# cobertura\n90%', pipelineRoot: root });
    assert.ok(fs.existsSync(res2.path), res2.path);
    assert.ok(
        res2.path.replace(/\\/g, '/').endsWith('.pipeline/assets/docs/321/tester-321.md'),
        res2.path,
    );
});

test('writeDeliverable rechaza payload sin md ni svg', () => {
    assert.throws(() => writeDeliverable('guru', '1', { pipelineRoot: tmpRoot() }), /requiere/);
});

test('writeDeliverable rechaza filename con path traversal', () => {
    assert.throws(
        () => writeDeliverable('guru', '1', { md: 'x', filename: '../../evil.md', pipelineRoot: tmpRoot() }),
        /filename inválido/,
    );
});

test('writeDeliverable respeta filename plano explícito', () => {
    const root = tmpRoot();
    const { path: file } = writeDeliverable('guru', '5', {
        md: 'x',
        filename: 'analisis-tecnico.md',
        pipelineRoot: root,
    });
    assert.ok(file.replace(/\\/g, '/').endsWith('.pipeline/assets/docs/5/analisis-tecnico.md'), file);
});

// -----------------------------------------------------------------------------
// CA-9 — cap de tamaño
// -----------------------------------------------------------------------------

test('writeDeliverable rechaza artefacto que excede maxBytes', () => {
    assert.throws(
        () => writeDeliverable('guru', '1', { md: 'x'.repeat(100), maxBytes: 10, pipelineRoot: tmpRoot() }),
        /excede maxBytes/,
    );
});
