// =============================================================================
// Tests deliverable-notify.js — #3414
//
// Cubre CA-T-1 del issue:
//   - Construcción de mensaje correcto por skill (guru / po / ux / planner)
//   - Truncado a truncate_chars con preservación de línea
//   - Envelope canónico presente, bien formado y reversible al parsear
//   - Validación de path del adjunto (los 4 casos de CA-SEC-1)
//   - Dedup por content_hash (CA-FN-7)
//   - Fallback text-only cuando PNG no existe / inválido
//   - Audit record bien formado (sanitizado, truncado, sin paths absolutos)
//   - Kill-switch + enabled gating (CA-FN-6)
//   - Zero-blocking ante errores (CA-FN-8)
//
// Estrategia: trabajamos contra un `pipelineRoot` temporal con
// `fs.mkdtempSync` para no tocar el `.pipeline/` real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dn = require('../deliverable-notify');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-notify-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function defaultCfg(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        skills: ['guru', 'po', 'ux', 'planner'],
        truncate_chars: 1500,
        attachment_root: '.pipeline/assets/mockups',
        dedup_window_hours: 24,
        audit_file: '.pipeline/audit/deliverable-notifications.jsonl',
    }, overrides || {});
}

function notasMultilinea(extraLines) {
    const base = [
        '## Resumen',
        'Análisis del issue 3414.',
        '',
        '## Hallazgos',
        '- punto 1',
        '- punto 2',
    ];
    if (extraLines) base.push(...extraLines);
    return base.join('\n');
}

// -----------------------------------------------------------------------------
// CA-UX-2 · emojis canónicos
// -----------------------------------------------------------------------------

test('CA-UX-2 · emojiForSkill devuelve el emoji canónico por skill notificable', () => {
    const { emojiForSkill } = dn.__forTests__;
    assert.equal(emojiForSkill('guru'), '🔍');
    assert.equal(emojiForSkill('po'), '📋');
    assert.equal(emojiForSkill('ux'), '🎨');
    assert.equal(emojiForSkill('planner'), '🗺️');
});

test('CA-UX-2 · emojiForSkill devuelve fallback neutral para skill desconocido', () => {
    const { emojiForSkill } = dn.__forTests__;
    assert.equal(emojiForSkill('tester'), '📦');
    assert.equal(emojiForSkill(''), '📦');
    assert.equal(emojiForSkill(undefined), '📦');
});

// -----------------------------------------------------------------------------
// CA-UX-4 · truncado preservando líneas
// -----------------------------------------------------------------------------

test('CA-UX-4 · truncatePreserveLines no toca texto bajo el límite', () => {
    const { truncatePreserveLines } = dn.__forTests__;
    const short = 'línea uno\nlínea dos';
    assert.equal(truncatePreserveLines(short, 100), short);
});

test('CA-UX-4 · truncatePreserveLines agrega marcador y corta en límite de línea', () => {
    const { truncatePreserveLines } = dn.__forTests__;
    const text = ['aaa', 'bbb', 'cccccccccccccccccccc', 'ddd'].join('\n');
    const r = truncatePreserveLines(text, 12); // forzar truncado
    assert.ok(r.endsWith('_(continúa en el issue)_'), 'sufijo presente');
    // El sufijo debe aparecer al final, después del texto cortado
    assert.ok(r.includes('aaa'));
});

test('CA-UX-4 · truncatePreserveLines tolera input no-string', () => {
    const { truncatePreserveLines } = dn.__forTests__;
    assert.equal(truncatePreserveLines(null, 100), '');
    assert.equal(truncatePreserveLines(undefined, 100), '');
    assert.equal(truncatePreserveLines(123, 100), '');
});

// -----------------------------------------------------------------------------
// CA-FN-5 / CA-SEC-2 · envelope canónico
// -----------------------------------------------------------------------------

test('CA-FN-5 · buildEnvelope produce HTML comment con JSON parseable', () => {
    const { buildEnvelope } = dn.__forTests__;
    const env = buildEnvelope({ issue: 3414, fase: 'criterios', skill: 'ux', pipeline: 'definicion' });
    assert.match(env, /^<!-- pipeline-meta /);
    assert.match(env, / -->$/);
    // Extraer el JSON entre los marcadores
    const m = env.match(/pipeline-meta (\{.*\}) -->/);
    assert.ok(m, 'el envelope contiene un JSON');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.issue, 3414);
    assert.equal(parsed.fase, 'criterios');
    assert.equal(parsed.skill, 'ux');
    assert.equal(parsed.pipeline, 'definicion');
    assert.equal(typeof parsed.ts, 'number');
});

test('CA-FN-5 · buildEnvelope normaliza issue a número', () => {
    const { buildEnvelope } = dn.__forTests__;
    const env = buildEnvelope({ issue: '3414', fase: 'analisis', skill: 'guru', pipeline: 'definicion' });
    const m = env.match(/pipeline-meta (\{.*\}) -->/);
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.issue, 3414);
    assert.equal(typeof parsed.issue, 'number');
});

// -----------------------------------------------------------------------------
// CA-SEC-1 · validación de path del adjunto
// -----------------------------------------------------------------------------

test('CA-SEC-1 · validateAttachmentPath rechaza `..` (parent_segment)', () => {
    const { validateAttachmentPath } = dn.__forTests__;
    const r = validateAttachmentPath('../../etc/passwd', {
        root: '.pipeline/assets/mockups',
        pipelineRoot: '/tmp/fake-root',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'parent_segment');
});

test('CA-SEC-1 · validateAttachmentPath rechaza null-byte', () => {
    const { validateAttachmentPath } = dn.__forTests__;
    const r = validateAttachmentPath('foo\0bar.png', {
        root: '.pipeline/assets/mockups',
        pipelineRoot: '/tmp/fake-root',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'null_byte');
});

test('CA-SEC-1 · validateAttachmentPath rechaza path absoluto fuera del root', () => {
    const { validateAttachmentPath } = dn.__forTests__;
    const { root, cleanup } = mkTmpRoot();
    try {
        // Path absoluto a `os.tmpdir()` (fuera del attachment_root resuelto)
        const r = validateAttachmentPath(os.homedir() + '/secrets.png', {
            root: '.pipeline/assets/mockups',
            pipelineRoot: root,
        });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'outside_root');
    } finally {
        cleanup();
    }
});

test('CA-SEC-1 · validateAttachmentPath rechaza string vacío', () => {
    const { validateAttachmentPath } = dn.__forTests__;
    const r = validateAttachmentPath('', { root: 'mockups', pipelineRoot: '/tmp' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
});

test('CA-SEC-1 · validateAttachmentPath acepta path válido bajo root', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const { validateAttachmentPath } = dn.__forTests__;
        // Crear el archivo en el root para que existsSync pase
        const attachmentRoot = path.join(root, '.pipeline', 'assets', 'mockups');
        fs.mkdirSync(attachmentRoot, { recursive: true });
        const filePath = path.join(attachmentRoot, '3414-mockup.png');
        fs.writeFileSync(filePath, 'fake-png-bytes');

        const r = validateAttachmentPath(
            '.pipeline/assets/mockups/3414-mockup.png',
            { root: '.pipeline/assets/mockups', pipelineRoot: root },
        );
        assert.equal(r.ok, true);
        assert.ok(r.relative.endsWith('3414-mockup.png'));
        assert.equal(path.isAbsolute(r.absolute), true);
    } finally {
        cleanup();
    }
});

// -----------------------------------------------------------------------------
// buildPreview · text-only por skill notificable
// -----------------------------------------------------------------------------

test('CA-UX-1 · buildPreview produce text-only para guru con header + preview + footer + envelope', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const out = dn.buildPreview({
            issue: 3414,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: { resultado: 'aprobado', notas: notasMultilinea() },
            title: 'Notificación Telegram de entregables parciales',
            config: defaultCfg(),
            pipelineRoot: root,
        });
        // Es text-only (no photo)
        assert.equal(out.payload.photo, undefined);
        assert.equal(typeof out.payload.text, 'string');
        // Header: emoji + #N + fase + skill
        assert.match(out.payload.text, /🔍 #3414 · analisis · guru/);
        // Subtítulo presente (acortado si excede 80)
        assert.match(out.payload.text, /Notificación Telegram de entregables parciales/);
        // Footer URL
        assert.match(out.payload.text, /🔗 https:\/\/github\.com\/intrale\/platform\/issues\/3414/);
        // Envelope al final
        assert.match(out.payload.text, /<!-- pipeline-meta \{.*"skill":"guru".*\} -->/);
        // parse_mode
        assert.equal(out.payload.parse_mode, 'Markdown');
    } finally { cleanup(); }
});

test('buildPreview usa emoji correcto para cada skill', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const cases = [
            { skill: 'guru', emoji: '🔍' },
            { skill: 'po', emoji: '📋' },
            { skill: 'planner', emoji: '🗺️' },
        ];
        for (const { skill, emoji } of cases) {
            const out = dn.buildPreview({
                issue: 100,
                skill,
                fase: 'criterios',
                pipeline: 'definicion',
                yaml: { notas: 'preview' },
                config: defaultCfg(),
                pipelineRoot: root,
            });
            assert.ok(out.payload.text.startsWith(`${emoji} #100 · criterios · ${skill}`),
                `${skill} debe arrancar con su emoji`);
        }
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-FN-4 · fallback text-only cuando PNG no existe / inválido
// -----------------------------------------------------------------------------

test('CA-FN-4 · buildPreview para ux degrada a text-only si el PNG no existe', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const out = dn.buildPreview({
            issue: 3414,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: {
                notas: 'mockup pendiente',
                photo: '.pipeline/assets/mockups/no-existe.png',
            },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(out.payload.photo, undefined);
        assert.equal(typeof out.payload.text, 'string');
        assert.equal(out.attachmentRejected, true);
        // El audit record debe registrar el rejection
        assert.equal(out.auditRecord.attachment_rejected, true);
        assert.ok(out.auditRecord.attachment_reject_reason);
    } finally { cleanup(); }
});

test('CA-FN-4 + CA-SEC-1 · buildPreview rechaza photo con path-traversal y degrada', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const out = dn.buildPreview({
            issue: 3414,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: {
                notas: 'preview',
                photo: '../../etc/passwd',
            },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(out.payload.photo, undefined);
        assert.equal(out.attachmentRejected, true);
        assert.equal(out.auditRecord.attachment_reject_reason, 'parent_segment');
    } finally { cleanup(); }
});

test('CA-FN-4 · buildPreview para ux con PNG válido produce sendPhoto + caption corto', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // Crear el PNG fake en el root
        const mockupsDir = path.join(root, '.pipeline', 'assets', 'mockups');
        fs.mkdirSync(mockupsDir, { recursive: true });
        const photoPath = path.join(mockupsDir, '3414.png');
        fs.writeFileSync(photoPath, 'fake');

        const out = dn.buildPreview({
            issue: 3414,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: {
                notas: notasMultilinea(),
                photo: '.pipeline/assets/mockups/3414.png',
            },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.ok(typeof out.payload.photo === 'string', 'sendPhoto multipart');
        assert.ok(out.payload.photo.endsWith('3414.png'));
        assert.ok(typeof out.payload.caption === 'string');
        // El caption NO debe llevar el preview de notas (CA-UX-5)
        assert.ok(!out.payload.caption.includes('## Hallazgos'),
            'caption corto no incluye notas detalladas');
        // Pero SÍ debe incluir header + link + envelope
        assert.match(out.payload.caption, /🎨 #3414 · criterios · ux/);
        assert.match(out.payload.caption, /<!-- pipeline-meta /);
        // Audit guarda la ruta RELATIVA (no absoluta)
        assert.equal(out.auditRecord.attachment_path, '.pipeline/assets/mockups/3414.png');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-UX-4 · truncado del preview por config
// -----------------------------------------------------------------------------

test('CA-UX-4 · buildPreview trunca el preview a truncate_chars', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const huge = ('A'.repeat(50) + '\n').repeat(100); // ~5000 chars
        const out = dn.buildPreview({
            issue: 100,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: { notas: huge },
            config: defaultCfg({ truncate_chars: 300 }),
            pipelineRoot: root,
        });
        // El mensaje total no debe exceder mucho más allá del truncate_chars
        // (suma header + envelope + URL → ~250 chars de overhead máx)
        assert.ok(out.payload.text.length < 1000,
            `mensaje truncado debe ser corto, fue ${out.payload.text.length}`);
        assert.ok(out.payload.text.includes('_(continúa en el issue)_'),
            'sufijo de continuación');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-UX-4 · fallback cuando notas está vacía
// -----------------------------------------------------------------------------

test('CA-UX-4 · buildPreview fallback cuando notas está vacía', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const out = dn.buildPreview({
            issue: 100,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: { notas: '' },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.match(out.payload.text, /Sin preview disponible/);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-SEC-3 · audit record bien formado
// -----------------------------------------------------------------------------

test('CA-SEC-3 · auditRecord trae content_hash, preview truncado y campos canónicos', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const out = dn.buildPreview({
            issue: 3414,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: { notas: notasMultilinea() },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.ok(out.auditRecord.ts, 'ts presente');
        assert.equal(out.auditRecord.issue, 3414);
        assert.equal(out.auditRecord.fase, 'analisis');
        assert.equal(out.auditRecord.skill, 'guru');
        assert.equal(out.auditRecord.pipeline, 'definicion');
        // content_hash es SHA-256 (64 chars hex)
        assert.match(out.auditRecord.content_hash, /^[a-f0-9]{64}$/);
        // preview ≤ AUDIT_PREVIEW_MAX (200)
        assert.ok(out.auditRecord.preview.length <= dn.AUDIT_PREVIEW_MAX);
        // attachment_path = null en text-only
        assert.equal(out.auditRecord.attachment_path, null);
    } finally { cleanup(); }
});

test('CA-SEC-3 · auditRecord nunca persiste path absoluto en attachment_path', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const mockupsDir = path.join(root, '.pipeline', 'assets', 'mockups');
        fs.mkdirSync(mockupsDir, { recursive: true });
        fs.writeFileSync(path.join(mockupsDir, 'x.png'), 'fake');

        const out = dn.buildPreview({
            issue: 999,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: { notas: 'n', photo: '.pipeline/assets/mockups/x.png' },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(path.isAbsolute(out.auditRecord.attachment_path), false,
            'attachment_path debe ser relativo');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-FN-7 · dedup
// -----------------------------------------------------------------------------

test('CA-FN-7 · shouldSkipByDedup detecta hash repetido dentro de la ventana', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const auditPath = path.join(root, 'audit.jsonl');
        const hash = 'a'.repeat(64);
        // Entry reciente (mismo issue + skill + hash)
        fs.writeFileSync(auditPath, JSON.stringify({
            ts: new Date().toISOString(),
            issue: 3414,
            skill: 'guru',
            content_hash: hash,
        }) + '\n');

        const skip = dn.shouldSkipByDedup({
            auditPath,
            issue: 3414,
            skill: 'guru',
            contentHash: hash,
            windowHours: 24,
        });
        assert.equal(skip, true);
    } finally { cleanup(); }
});

test('CA-FN-7 · shouldSkipByDedup no salta si el hash difiere', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const auditPath = path.join(root, 'audit.jsonl');
        fs.writeFileSync(auditPath, JSON.stringify({
            ts: new Date().toISOString(),
            issue: 3414,
            skill: 'guru',
            content_hash: 'a'.repeat(64),
        }) + '\n');

        const skip = dn.shouldSkipByDedup({
            auditPath,
            issue: 3414,
            skill: 'guru',
            contentHash: 'b'.repeat(64),
            windowHours: 24,
        });
        assert.equal(skip, false);
    } finally { cleanup(); }
});

test('CA-FN-7 · shouldSkipByDedup ignora entradas fuera de la ventana temporal', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const auditPath = path.join(root, 'audit.jsonl');
        const oldTs = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h atrás
        fs.writeFileSync(auditPath, JSON.stringify({
            ts: oldTs,
            issue: 3414,
            skill: 'guru',
            content_hash: 'a'.repeat(64),
        }) + '\n');

        const skip = dn.shouldSkipByDedup({
            auditPath,
            issue: 3414,
            skill: 'guru',
            contentHash: 'a'.repeat(64),
            windowHours: 24, // ventana 24h, entry 48h atrás
        });
        assert.equal(skip, false);
    } finally { cleanup(); }
});

test('CA-FN-7 · shouldSkipByDedup tolera archivo inexistente', () => {
    const skip = dn.shouldSkipByDedup({
        auditPath: '/tmp/no-existe-jamas-' + Date.now() + '.jsonl',
        issue: 1,
        skill: 'guru',
        contentHash: 'x',
        windowHours: 24,
    });
    assert.equal(skip, false);
});

// -----------------------------------------------------------------------------
// notify · fachada con dedup + audit + dropfile
// -----------------------------------------------------------------------------

test('CA-FN-6 · notify NO encola cuando enabled=false', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 3414, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'x' },
            config: defaultCfg({ enabled: false }),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'disabled');
        assert.equal(calls.length, 0);
    } finally { cleanup(); }
});

test('CA-FN-6 · notify NO encola cuando kill_switch=true (incluso con enabled=true)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 3414, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'x' },
            config: defaultCfg({ enabled: true, kill_switch: true }),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'kill_switch');
        assert.equal(calls.length, 0);
    } finally { cleanup(); }
});

test('CA-FN-2 · notify NO encola para skill fuera del subset', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 3414, skill: 'tester', fase: 'verificacion', pipeline: 'desarrollo',
            yaml: { notas: 'x' },
            config: defaultCfg(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'skill_not_notifiable');
        assert.equal(calls.length, 0);
    } finally { cleanup(); }
});

test('CA-FN-1 · notify encola dropfile + audit cuando aplica', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const queueDir = path.join(root, '.pipeline', 'servicios', 'telegram', 'pendiente');
        const result = dn.notify({
            issue: 3414, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: notasMultilinea() },
            config: defaultCfg(),
            pipelineRoot: root,
            telegramQueueDir: queueDir,
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.ok, true);
        assert.equal(result.action, 'enqueued');
        assert.equal(calls.length, 1);
        assert.ok(calls[0].p.includes('deliverable-3414-guru'),
            'el filename del dropfile incluye issue+skill');
        // El payload tiene text + parse_mode
        assert.ok(typeof calls[0].payload.text === 'string');
        assert.equal(calls[0].payload.parse_mode, 'Markdown');
        // Audit JSONL escrito
        const auditPath = path.join(root, '.pipeline/audit/deliverable-notifications.jsonl');
        assert.equal(fs.existsSync(auditPath), true);
        const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
        const lastEntry = JSON.parse(auditLines[auditLines.length - 1]);
        assert.equal(lastEntry.telegram_enqueue_ok, true);
        assert.equal(lastEntry.issue, 3414);
    } finally { cleanup(); }
});

test('CA-FN-7 · notify aplica dedup en una segunda invocación con mismo content', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const queueDir = path.join(root, '.pipeline', 'servicios', 'telegram', 'pendiente');
        const cfg = defaultCfg();
        const args = {
            issue: 3414, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'idéntico' },
            config: cfg,
            pipelineRoot: root,
            telegramQueueDir: queueDir,
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        };
        const r1 = dn.notify(args);
        const r2 = dn.notify(args);
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, false);
        assert.equal(r2.reason, 'dedup');
        assert.equal(calls.length, 1, 'solo se encoló una vez');
    } finally { cleanup(); }
});

test('CA-FN-8 · notify nunca tira excepción ante input malformado', () => {
    // Pasamos un config sin enabled, yaml null, queueDir indefinido —
    // queremos que devuelva `{ok:false}` y no propague.
    const r = dn.notify({
        issue: undefined,
        skill: null,
        fase: undefined,
        pipeline: undefined,
        yaml: null,
        config: null,
        pipelineRoot: undefined,
        telegramQueueDir: undefined,
    });
    assert.equal(r.ok, false);
});

// -----------------------------------------------------------------------------
// appendAudit
// -----------------------------------------------------------------------------

test('appendAudit crea el directorio si no existe y persiste JSONL', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const auditPath = path.join(root, 'sub', 'dir', 'audit.jsonl');
        const ok = dn.appendAudit(auditPath, { ts: 'now', issue: 1, skill: 'guru' });
        assert.equal(ok, true);
        const content = fs.readFileSync(auditPath, 'utf8');
        assert.match(content, /"issue":1/);
        assert.ok(content.endsWith('\n'));
    } finally { cleanup(); }
});

test('appendAudit retorna false si record es null', () => {
    assert.equal(dn.appendAudit('/tmp/whatever.jsonl', null), false);
});
