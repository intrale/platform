// =============================================================================
// Tests deliverable-notify.js — Adjuntos multimedia (#3540)
//
// Cubre:
//   CA-FUNC-1..8 + CA-SEC-EXT-1..3,5..8 + CA-UX-EXT-1..7
//
// Convención: cada test crea un `pipelineRoot` temporal con todos los
// `attachment_roots` por tipo y escribe fixtures con magic bytes válidos para
// pasar `verifyMagicBytes`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dn = require('../deliverable-notify');
const ma = require('../multimedia-attachment');

// -----------------------------------------------------------------------------
// helpers — magic bytes válidos
// -----------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_SIGNATURE = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
const PDF_SIGNATURE = Buffer.from('%PDF-1.4\n', 'utf8');
const GIF_SIGNATURE = Buffer.from('GIF89a', 'utf8');
const MP4_SIGNATURE = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'utf8'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2', 'utf8'),
]);
const WEBM_SIGNATURE = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0xA3, 0x42, 0x86, 0x81]);

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-attach-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function writeFixture(absPath, signature, totalBytes) {
    const total = totalBytes || (signature.length + 32);
    const padding = Buffer.alloc(Math.max(0, total - signature.length), 0);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.concat([signature, padding]));
}

function defaultCfg(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        skills: ['guru', 'po', 'ux', 'planner'],
        truncate_chars: 1500,
        // #3931 — sin `attachment_root` legacy; `video` repuntado a qa/evidence (B9);
        // root `animation` provisto por el default de engine (DEFAULT_ATTACHMENT_ROOTS).
        attachment_roots: {
            document:  '.pipeline/assets/docs',
            image:     '.pipeline/assets/mockups',
            video:     'qa/evidence',
        },
        attachments_per_skill: {
            guru:    { types: ['document'],                formats: ['.pdf', '.md'] },
            po:      { types: ['document'],                formats: ['.pdf', '.md'] },
            planner: { types: ['document'],                formats: ['.pdf', '.md'] },
            ux:      { types: ['image', 'video'],          formats: ['.png', '.jpg', '.jpeg', '.mp4', '.webm'] },
            qa:      { types: ['video', 'document'],       formats: ['.mp4', '.webm', '.pdf'] },
        },
        attachment_max_count: 5,
        attachment_max_size_bytes: 50 * 1024 * 1024,
        attachment_video_max_duration_s: 300,
        dedup_window_hours: 24,
        audit_file: '.pipeline/audit/deliverable-notifications.jsonl',
    }, overrides || {});
}

// #3931 — ux ya no declara `animation`/`.gif` en config de producción (sin
// productor real). El engine, sin embargo, SIGUE soportando el type `animation`
// (#3540: ATTACHMENT_DROPFILE_FIELD/emoji/sendAnimation) para futuros productores.
// Los tests de capacidad del engine sobre `animation` usan este override para
// habilitar el type sin reintroducirlo en la whitelist de producción.
const UX_ENGINE_ANIMATION = {
    ux: { types: ['image', 'video', 'animation'], formats: ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'] },
};

// Stub de probeVideoDurationSeconds — para tests no necesitamos ffprobe real.
function fakeProbe(durationS) {
    return () => ({ ok: true, duration_s: durationS });
}

// -----------------------------------------------------------------------------
// multimedia-attachment.js — verifyMagicBytes
// -----------------------------------------------------------------------------

test('CA-SEC-EXT-2 · verifyMagicBytes acepta PNG con signature válida', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'ok.png');
        writeFixture(p, PNG_SIGNATURE);
        const r = ma.verifyMagicBytes(p, 'image/png');
        assert.equal(r.ok, true);
        assert.equal(r.skipped, false);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes rechaza PNG con bytes spoofed (mime_mismatch)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'fake.png');
        fs.writeFileSync(p, 'definitely not a png');
        const r = ma.verifyMagicBytes(p, 'image/png');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'mime_mismatch');
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes acepta PDF con %PDF-', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'doc.pdf');
        writeFixture(p, PDF_SIGNATURE);
        const r = ma.verifyMagicBytes(p, 'application/pdf');
        assert.equal(r.ok, true);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes acepta MP4 con ftyp atom en offset 4', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'video.mp4');
        writeFixture(p, MP4_SIGNATURE);
        const r = ma.verifyMagicBytes(p, 'video/mp4');
        assert.equal(r.ok, true);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes acepta WebM EBML magic', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'video.webm');
        writeFixture(p, WEBM_SIGNATURE);
        const r = ma.verifyMagicBytes(p, 'video/webm');
        assert.equal(r.ok, true);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes acepta GIF87a y GIF89a', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p1 = path.join(root, '87.gif');
        const p2 = path.join(root, '89.gif');
        writeFixture(p1, Buffer.from('GIF87a', 'utf8'));
        writeFixture(p2, Buffer.from('GIF89a', 'utf8'));
        assert.equal(ma.verifyMagicBytes(p1, 'image/gif').ok, true);
        assert.equal(ma.verifyMagicBytes(p2, 'image/gif').ok, true);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes con markdown declara skipped:true sin tirar', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'notes.md');
        fs.writeFileSync(p, '# heading');
        const r = ma.verifyMagicBytes(p, 'text/markdown');
        assert.equal(r.ok, true);
        assert.equal(r.skipped, true);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · verifyMagicBytes para mime desconocido devuelve mime_unknown', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, 'foo.bin');
        fs.writeFileSync(p, 'whatever');
        const r = ma.verifyMagicBytes(p, 'application/octet-stream');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'mime_unknown');
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · mimeForPath mapea extensiones soportadas', () => {
    assert.equal(ma.mimeForPath('a.pdf'), 'application/pdf');
    assert.equal(ma.mimeForPath('a.PNG'), 'image/png');
    assert.equal(ma.mimeForPath('a.JPG'), 'image/jpeg');
    assert.equal(ma.mimeForPath('a.jpeg'), 'image/jpeg');
    assert.equal(ma.mimeForPath('a.mp4'), 'video/mp4');
    assert.equal(ma.mimeForPath('a.webm'), 'video/webm');
    assert.equal(ma.mimeForPath('a.gif'), 'image/gif');
    assert.equal(ma.mimeForPath('a.md'), 'text/markdown');
    // V1: html NO soportado (CA-UX-EXT-6 diferido a V2)
    assert.equal(ma.mimeForPath('a.html'), null);
    assert.equal(ma.mimeForPath('a.exe'), null);
});

// -----------------------------------------------------------------------------
// resolveAttachments — V1 multi-attachment
// -----------------------------------------------------------------------------

test('CA-FUNC-1 · resolveAttachments acepta document PDF para guru', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const docPath = path.join(root, '.pipeline/assets/docs/3540-analysis.pdf');
        writeFixture(docPath, PDF_SIGNATURE, 256);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'guru',
            yaml: {
                attachments: [{ type: 'document', path: '.pipeline/assets/docs/3540-analysis.pdf' }],
            },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records.length, 1);
        assert.equal(records[0].accepted, true);
        assert.equal(records[0].type, 'document');
        assert.equal(records[0].mime, 'application/pdf');
        assert.equal(records[0].magic_byte_verified, true);
        assert.equal(records[0].size, 256);
        assert.ok(records[0].filename.startsWith('3540-guru-'));
        assert.ok(records[0].filename.endsWith('.pdf'));
    } finally { cleanup(); }
});

test('CA-FUNC-1 · resolveAttachments rechaza document para ux (type_not_allowed_for_skill)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const docPath = path.join(root, '.pipeline/assets/docs/3540.pdf');
        writeFixture(docPath, PDF_SIGNATURE);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments: [{ type: 'document', path: '.pipeline/assets/docs/3540.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records.length, 1);
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'type_not_allowed_for_skill');
    } finally { cleanup(); }
});

test('CA-FUNC-2 · resolveAttachments acepta múltiples adjuntos (image + video) para ux', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const png = path.join(root, '.pipeline/assets/mockups/3540.png');
        const mp4 = path.join(root, 'qa/evidence/3540/3540.mp4');
        writeFixture(png, PNG_SIGNATURE, 128);
        writeFixture(mp4, MP4_SIGNATURE, 512);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: {
                attachments: [
                    { type: 'image', path: '.pipeline/assets/mockups/3540.png' },
                    { type: 'video', path: 'qa/evidence/3540/3540.mp4' },
                ],
            },
            config: defaultCfg(),
            pipelineRoot: root,
            deps: { probeVideoDurationSeconds: fakeProbe(47) },
        });
        assert.equal(records.length, 2);
        assert.equal(records[0].accepted, true);
        assert.equal(records[0].type, 'image');
        assert.equal(records[1].accepted, true);
        assert.equal(records[1].type, 'video');
        assert.equal(records[1].duration_s, 47);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-1 · resolveAttachments rechaza path-traversal con razón parent_segment', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments: [{ type: 'image', path: '../../etc/passwd.png' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'parent_segment');
    } finally { cleanup(); }
});

test('CA-SEC-EXT-1 · resolveAttachments rechaza null-byte', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'guru',
            yaml: { attachments: [{ type: 'document', path: 'foo\0bar.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'null_byte');
    } finally { cleanup(); }
});

test('CA-SEC-EXT-1 · resolveAttachments rechaza path fuera del root del tipo (outside_root)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // PDF en docs/ pero declarado como image → image_root = mockups/
        // → outside_root (porque docs/ no está bajo mockups/).
        const docPath = path.join(root, '.pipeline/assets/docs/x.pdf');
        writeFixture(docPath, PDF_SIGNATURE);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'guru',
            yaml: { attachments: [{ type: 'document', path: '.pipeline/assets/mockups/3540.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        // El path '.pipeline/assets/mockups/3540.pdf' va al root del tipo
        // document (docs/), no a mockups → outside_root + file_not_found.
        assert.equal(records[0].accepted, false);
        assert.ok(['outside_root', 'file_not_found'].includes(records[0].reject_reason),
            `reason esperado outside_root o file_not_found, fue: ${records[0].reject_reason}`);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-2 · resolveAttachments rechaza archivo con magic bytes mismatch', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const fakePng = path.join(root, '.pipeline/assets/mockups/spoofed.png');
        fs.mkdirSync(path.dirname(fakePng), { recursive: true });
        fs.writeFileSync(fakePng, 'XXXXXXXXX'); // .png ext pero NO es PNG
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments: [{ type: 'image', path: '.pipeline/assets/mockups/spoofed.png' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'mime_mismatch');
    } finally { cleanup(); }
});

test('CA-SEC-EXT-3 · resolveAttachments rechaza video con duración > cap (duration_exceeded)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const mp4 = path.join(root, 'qa/evidence/3540/long.mp4');
        writeFixture(mp4, MP4_SIGNATURE);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments: [{ type: 'video', path: 'qa/evidence/3540/long.mp4' }] },
            config: defaultCfg({ attachment_video_max_duration_s: 60 }),
            pipelineRoot: root,
            deps: { probeVideoDurationSeconds: fakeProbe(120) }, // 120 > 60
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'duration_exceeded');
        assert.equal(records[0].duration_s, 120);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-3 · resolveAttachments deja pasar video si ffprobe falla (duration_probe_failed)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const mp4 = path.join(root, 'qa/evidence/3540/short.mp4');
        writeFixture(mp4, MP4_SIGNATURE);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments: [{ type: 'video', path: 'qa/evidence/3540/short.mp4' }] },
            config: defaultCfg(),
            pipelineRoot: root,
            deps: { probeVideoDurationSeconds: () => ({ ok: false, reason: 'spawn_failed' }) },
        });
        // No bloqueante: el adjunto pasa y se marca duration_probe_failed.
        assert.equal(records[0].accepted, true);
        assert.equal(records[0].duration_probe_failed, true);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-5 · resolveAttachments rechaza con size > cap (size_exceeded)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const big = path.join(root, '.pipeline/assets/docs/big.pdf');
        // Crear archivo con 200 bytes pero cap config a 100.
        writeFixture(big, PDF_SIGNATURE, 200);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'guru',
            yaml: { attachments: [{ type: 'document', path: '.pipeline/assets/docs/big.pdf' }] },
            config: defaultCfg({ attachment_max_size_bytes: 100 }),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'size_exceeded');
        assert.equal(records[0].size, 200);
    } finally { cleanup(); }
});

test('CA-SEC-EXT-5 · resolveAttachments aplica cap de cantidad (max_count_exceeded)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const attachments = [];
        for (let i = 0; i < 7; i++) {
            const p = path.join(root, `.pipeline/assets/mockups/img${i}.png`);
            writeFixture(p, PNG_SIGNATURE);
            attachments.push({ type: 'image', path: `.pipeline/assets/mockups/img${i}.png` });
        }
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments },
            config: defaultCfg({ attachment_max_count: 3 }),
            pipelineRoot: root,
        });
        const accepted = records.filter((r) => r.accepted);
        const rejected = records.filter((r) => !r.accepted);
        assert.equal(accepted.length, 3, 'cap = 3 adjuntos aceptados');
        assert.equal(rejected.length, 4, '4 rechazados por max_count_exceeded');
        assert.equal(rejected[0].reject_reason, 'max_count_exceeded');
    } finally { cleanup(); }
});

test('CA-SEC-EXT-5 · resolveAttachments rechaza archivo vacío (empty_file)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const p = path.join(root, '.pipeline/assets/docs/empty.pdf');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '');
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'guru',
            yaml: { attachments: [{ type: 'document', path: '.pipeline/assets/docs/empty.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'empty_file');
    } finally { cleanup(); }
});

test('CA-FUNC-1 · resolveAttachments rechaza extensión no permitida por skill (format_not_allowed)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // guru solo permite .pdf y .md — .png debería rechazar.
        const p = path.join(root, '.pipeline/assets/docs/wrong.png');
        writeFixture(p, PNG_SIGNATURE);
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'guru',
            yaml: { attachments: [{ type: 'image', path: '.pipeline/assets/docs/wrong.png' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        // image no es type permitido para guru → type_not_allowed_for_skill PRIMERO.
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'type_not_allowed_for_skill');
    } finally { cleanup(); }
});

test('CA-UX-EXT-6 · html NO está en types soportados (V1)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'po',
            yaml: { attachments: [{ type: 'html', path: 'whatever.html' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        assert.equal(records[0].reject_reason, 'type_not_supported');
    } finally { cleanup(); }
});

test('CA-FUNC-1 · resolveAttachments rechaza type/mime mismatch (.pdf declarado como image)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // ux permite image, pero el path es .pdf → type:'image' + mime PDF → mismatch.
        const p = path.join(root, '.pipeline/assets/mockups/spoofed.pdf');
        writeFixture(p, PDF_SIGNATURE);
        // Para llegar a la verificación type/mime, la extensión .pdf debe pasar
        // el format check de ux — que no incluye .pdf → reject por format_not_allowed.
        const records = dn.resolveAttachments({
            issue: 3540,
            skill: 'ux',
            yaml: { attachments: [{ type: 'image', path: '.pipeline/assets/mockups/spoofed.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        assert.equal(records[0].accepted, false);
        // ext .pdf NO está en formats ux → format_not_allowed (antes de magic).
        assert.equal(records[0].reject_reason, 'format_not_allowed');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// buildPreview — multi-attachment flow
// -----------------------------------------------------------------------------

test('CA-UX-EXT-4 · buildPreview multi-adjunto produce text + extraDropfiles en orden UX', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const png = path.join(root, '.pipeline/assets/mockups/3540.png');
        const mp4 = path.join(root, 'qa/evidence/3540/3540.mp4');
        const gif = path.join(root, '.pipeline/assets/animations/3540.gif');
        writeFixture(png, PNG_SIGNATURE);
        writeFixture(mp4, MP4_SIGNATURE);
        writeFixture(gif, GIF_SIGNATURE);

        const out = dn.buildPreview({
            issue: 3540,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: {
                notas: 'preview text',
                attachments: [
                    // Orden de entrada deliberadamente inverso al de envío.
                    { type: 'animation', path: '.pipeline/assets/animations/3540.gif' },
                    { type: 'video', path: 'qa/evidence/3540/3540.mp4' },
                    { type: 'image', path: '.pipeline/assets/mockups/3540.png' },
                ],
            },
            config: defaultCfg({ attachments_per_skill: UX_ENGINE_ANIMATION }),
            pipelineRoot: root,
            deps: { probeVideoDurationSeconds: fakeProbe(45) },
        });

        // CA-UX-EXT-4: el primer mensaje (payload) debe ser texto.
        assert.ok(typeof out.payload.text === 'string',
            'primer mensaje = texto (no foto)');
        assert.equal(out.payload.photo, undefined);

        // extraDropfiles debe estar en orden image → document → video → animation.
        assert.equal(out.extraDropfiles.length, 3);
        assert.ok(out.extraDropfiles[0].photo, 'orden[0] = image (photo)');
        assert.ok(out.extraDropfiles[1].video, 'orden[1] = video');
        assert.ok(out.extraDropfiles[2].animation, 'orden[2] = animation');
    } finally { cleanup(); }
});

test('CA-FUNC-3 · sendVideo payload tiene caption canónico + filename legible', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const mp4 = path.join(root, 'qa/evidence/3540/3540.mp4');
        writeFixture(mp4, MP4_SIGNATURE);
        const out = dn.buildPreview({
            issue: 3540,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: { notas: 'demo', attachments: [{ type: 'video', path: 'qa/evidence/3540/3540.mp4', descriptor: 'demo' }] },
            config: defaultCfg(),
            pipelineRoot: root,
            deps: { probeVideoDurationSeconds: fakeProbe(30) },
        });
        const videoDrop = out.extraDropfiles[0];
        assert.ok(videoDrop.video);
        assert.equal(videoDrop.parse_mode, 'Markdown');
        // CA-UX-EXT-3: filename legible
        assert.equal(videoDrop.filename, '3540-ux-demo.mp4');
        // CA-UX-EXT-1: header canónico
        assert.match(videoDrop.caption, /🎨 #3540 · criterios · ux/);
        // CA-UX-EXT-2: marker emoji de tipo
        assert.match(videoDrop.caption, /🎬 video/);
        // Envelope al final
        assert.match(videoDrop.caption, /<!-- pipeline-meta /);
        // Caption ≤ 1024 (CA-UX-EXT-7)
        assert.ok(videoDrop.caption.length <= 1024);
    } finally { cleanup(); }
});

test('CA-FUNC-2 · sendDocument payload para guru con PDF', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pdf = path.join(root, '.pipeline/assets/docs/3540-analysis.pdf');
        writeFixture(pdf, PDF_SIGNATURE);
        const out = dn.buildPreview({
            issue: 3540,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: { notas: 'análisis técnico', attachments: [{ type: 'document', path: '.pipeline/assets/docs/3540-analysis.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        const docDrop = out.extraDropfiles[0];
        assert.ok(docDrop.document);
        assert.match(docDrop.caption, /🔍 #3540 · analisis · guru/);
        assert.match(docDrop.caption, /📄 documento/);
    } finally { cleanup(); }
});

test('CA-FUNC-4 · sendAnimation payload para ux con GIF', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const gif = path.join(root, '.pipeline/assets/animations/3540.gif');
        writeFixture(gif, GIF_SIGNATURE);
        const out = dn.buildPreview({
            issue: 3540,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: { notas: 'demo gif', attachments: [{ type: 'animation', path: '.pipeline/assets/animations/3540.gif' }] },
            config: defaultCfg({ attachments_per_skill: UX_ENGINE_ANIMATION }),
            pipelineRoot: root,
        });
        const gifDrop = out.extraDropfiles[0];
        assert.ok(gifDrop.animation);
        assert.match(gifDrop.caption, /🎞️ animación/);
    } finally { cleanup(); }
});

test('CA-FUNC-7 · rechazos no bloquean: válidos siguen, rechazos van a audit', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const goodPng = path.join(root, '.pipeline/assets/mockups/good.png');
        writeFixture(goodPng, PNG_SIGNATURE);
        // No creamos el bad.png — file_not_found.
        const out = dn.buildPreview({
            issue: 3540,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: {
                notas: 'mixed',
                attachments: [
                    { type: 'image', path: '.pipeline/assets/mockups/good.png' },
                    { type: 'image', path: '.pipeline/assets/mockups/bad.png' },
                ],
            },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        // 1 aceptado → 1 extraDropfile.
        assert.equal(out.extraDropfiles.length, 1);
        // Footer informativo en el texto (CA-UX-EXT-5).
        assert.match(out.payload.text, /1 adjunto omitido/);
        // Audit con array attachments.
        assert.ok(Array.isArray(out.auditRecord.attachments));
        assert.equal(out.auditRecord.attachments.length, 2);
        const accepted = out.auditRecord.attachments.filter((a) => a.sent_ok);
        const rejected = out.auditRecord.attachments.filter((a) => !a.sent_ok);
        assert.equal(accepted.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reject_reason, 'file_not_found');
    } finally { cleanup(); }
});

test('CA-FUNC-8 · back-compat: yaml.photo legacy se trata como image y produce sendPhoto', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const photo = path.join(root, '.pipeline/assets/mockups/3414.png');
        writeFixture(photo, PNG_SIGNATURE);
        const out = dn.buildPreview({
            issue: 3414,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml: { notas: 'mockup', photo: '.pipeline/assets/mockups/3414.png' },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        // Modo legacy: payload directo con photo + caption (no extraDropfiles).
        assert.ok(out.payload.photo);
        assert.equal(out.extraDropfiles.length, 0);
        assert.equal(out.payload.text, undefined);
    } finally { cleanup(); }
});

test('CA-UX-EXT-3 · filename legible incluye descriptor sanitizado', () => {
    const helpers = dn.__forTests__;
    const fn = helpers.buildAttachmentFilename;
    assert.equal(
        fn({ issue: 3540, skill: 'qa', attachmentPath: 'foo/demo video.mp4', descriptor: 'demo $$$ video!' }),
        '3540-qa-demo-video.mp4',
    );
    assert.equal(
        fn({ issue: 9, skill: 'guru', attachmentPath: 'docs/analysis.pdf' }),
        '9-guru-analysis.pdf',
    );
});

// -----------------------------------------------------------------------------
// notify — multi-dropfile enqueue
// -----------------------------------------------------------------------------

test('CA-FUNC-5 · notify encola múltiples dropfiles en orden con sufijos -NN', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const png = path.join(root, '.pipeline/assets/mockups/3540.png');
        const mp4 = path.join(root, 'qa/evidence/3540/3540.mp4');
        writeFixture(png, PNG_SIGNATURE);
        writeFixture(mp4, MP4_SIGNATURE);
        const calls = [];
        const result = dn.notify({
            issue: 3540, skill: 'ux', fase: 'criterios', pipeline: 'definicion',
            yaml: {
                notas: 'multi',
                attachments: [
                    { type: 'image', path: '.pipeline/assets/mockups/3540.png' },
                    { type: 'video', path: 'qa/evidence/3540/3540.mp4' },
                ],
            },
            config: defaultCfg(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, '.pipeline/servicios/telegram/pendiente'),
            deps: {
                writeQueueFile: (p, payload) => calls.push({ p, payload }),
                probeVideoDurationSeconds: fakeProbe(30),
                now: () => 1700000000000,
            },
        });
        assert.equal(result.ok, true);
        // 3 dropfiles: 1 texto + 1 image + 1 video.
        assert.equal(calls.length, 3);
        assert.ok(calls[0].payload.text, '[0] = texto');
        assert.ok(calls[1].payload.photo, '[1] = photo (image)');
        assert.ok(calls[2].payload.video, '[2] = video');
        // Sufijos -00, -01, -02.
        assert.ok(calls[0].p.includes('-00.json'));
        assert.ok(calls[1].p.includes('-01.json'));
        assert.ok(calls[2].p.includes('-02.json'));
        // Audit con array dropfiles.
        assert.ok(Array.isArray(result.audit.dropfiles));
        assert.equal(result.audit.dropfiles.length, 3);
    } finally { cleanup(); }
});

test('CA-FUNC-1 · notify legacy: yaml.photo produce 1 solo dropfile sin sufijo', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const photo = path.join(root, '.pipeline/assets/mockups/3414.png');
        writeFixture(photo, PNG_SIGNATURE);
        const calls = [];
        const result = dn.notify({
            issue: 3414, skill: 'ux', fase: 'criterios', pipeline: 'definicion',
            yaml: { notas: 'legacy', photo: '.pipeline/assets/mockups/3414.png' },
            config: defaultCfg(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, '.pipeline/servicios/telegram/pendiente'),
            deps: {
                writeQueueFile: (p, payload) => calls.push({ p, payload }),
            },
        });
        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        // Sin sufijo `-NN` cuando es un solo dropfile (back-compat).
        assert.ok(calls[0].p.includes('deliverable-3414-ux.json'));
        assert.equal(result.audit.dropfiles, undefined,
            'legacy 1-dropfile no setea audit.dropfiles');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// Audit — CA-SEC-EXT-6
// -----------------------------------------------------------------------------

test('CA-SEC-EXT-6 · audit attachments[] solo persiste paths relativos', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const png = path.join(root, '.pipeline/assets/mockups/3540.png');
        const pdf = path.join(root, '.pipeline/assets/docs/3540.pdf');
        writeFixture(png, PNG_SIGNATURE);
        writeFixture(pdf, PDF_SIGNATURE);
        const out = dn.buildPreview({
            issue: 3540,
            skill: 'guru',  // guru solo acepta document → image será rechazado
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: {
                notas: 'multi',
                attachments: [
                    { type: 'image', path: '.pipeline/assets/mockups/3540.png' },
                    { type: 'document', path: '.pipeline/assets/docs/3540.pdf' },
                ],
            },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        const audit = out.auditRecord;
        assert.ok(Array.isArray(audit.attachments));
        for (const a of audit.attachments) {
            if (a.path) {
                assert.equal(path.isAbsolute(a.path), false,
                    `path debe ser relativo, fue: ${a.path}`);
            }
        }
    } finally { cleanup(); }
});

test('CA-SEC-EXT-6 · audit attachments[] documenta cada record con shape estable', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const pdf = path.join(root, '.pipeline/assets/docs/3540.pdf');
        writeFixture(pdf, PDF_SIGNATURE);
        const out = dn.buildPreview({
            issue: 3540,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            yaml: { notas: 'x', attachments: [{ type: 'document', path: '.pipeline/assets/docs/3540.pdf' }] },
            config: defaultCfg(),
            pipelineRoot: root,
        });
        const rec = out.auditRecord.attachments[0];
        assert.equal(rec.type, 'document');
        assert.equal(rec.mime, 'application/pdf');
        assert.equal(rec.sent_ok, true);
        assert.equal(rec.magic_byte_verified, true);
        assert.ok(rec.path);
        assert.ok(Number.isFinite(rec.size));
        assert.ok(rec.filename);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// Captions — CA-UX-EXT-1, CA-UX-EXT-2, CA-UX-EXT-7
// -----------------------------------------------------------------------------

test('CA-UX-EXT-1+2 · buildAttachmentCaption tiene header canónico y marker por tipo', () => {
    const { buildAttachmentCaption } = dn.__forTests__;
    const cap = buildAttachmentCaption({
        issue: 3540,
        title: 'Adjuntos multimedia',
        fase: 'criterios',
        skill: 'ux',
        envelope: '<!-- pipeline-meta {} -->',
        attachmentType: 'video',
    });
    assert.match(cap, /🎨 #3540 · criterios · ux/);
    assert.match(cap, /🎬 video/);
    assert.match(cap, /github\.com\/intrale\/platform\/issues\/3540/);
    assert.ok(cap.length <= 1024, 'caption ≤ 1024 chars (CA-UX-EXT-7)');
});

test('CA-UX-EXT-2 · ATTACHMENT_TYPE_EMOJI cubre los 4 tipos V1', () => {
    assert.equal(dn.ATTACHMENT_TYPE_EMOJI.document, '📄');
    assert.equal(dn.ATTACHMENT_TYPE_EMOJI.image, '🖼️');
    assert.equal(dn.ATTACHMENT_TYPE_EMOJI.video, '🎬');
    assert.equal(dn.ATTACHMENT_TYPE_EMOJI.animation, '🎞️');
});

test('CA-UX-EXT-4 · ATTACHMENT_TYPE_ORDER define el orden de envío canónico', () => {
    assert.deepEqual(dn.ATTACHMENT_TYPE_ORDER, ['image', 'document', 'video', 'animation']);
});

test('CA-UX-EXT-6 · html NO está en DEFAULT_ATTACHMENTS_PER_SKILL (V1)', () => {
    const allSkills = Object.values(dn.DEFAULT_ATTACHMENTS_PER_SKILL);
    for (const cfg of allSkills) {
        assert.ok(!cfg.types.includes('html'), 'ningún skill V1 lista html');
        assert.ok(!cfg.formats.includes('.html'), 'ningún skill V1 acepta .html');
    }
});
