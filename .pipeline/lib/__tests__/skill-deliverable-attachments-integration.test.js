// =============================================================================
// Integration test — skill-deliverable-attachments + deliverable-notify (#3647)
//
// Cubre el flujo end-to-end del CA-2:
//   1. El helper escanea disco para `ux` y devuelve 2 PNGs.
//   2. El pulpo (simulado) fusiona el resultado en `yaml.attachments` antes
//      de invocar `deliverable-notify.notify(...)`.
//   3. La notify produce dropfiles en telegramQueueDir.
//   4. Verificamos que los dropfiles incluyen los 2 adjuntos (uno por PNG).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helper = require('../skill-deliverable-attachments');
const dn = require('../deliverable-notify');

// Magic bytes mínimos para que verifyMagicBytes acepte PNG.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-attach-int-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function writePng(absPath, totalBytes) {
    const total = totalBytes || (PNG_SIGNATURE.length + 64);
    const padding = Buffer.alloc(Math.max(0, total - PNG_SIGNATURE.length), 0);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.concat([PNG_SIGNATURE, padding]));
}

function defaultCfg() {
    return {
        enabled: true,
        kill_switch: false,
        skills: ['guru', 'po', 'ux', 'planner'],
        truncate_chars: 1500,
        attachment_root: '.pipeline/assets/mockups',
        attachment_roots: {
            document:  '.pipeline/assets/docs',
            image:     '.pipeline/assets/mockups',
            video:     '.pipeline/assets/videos',
            animation: '.pipeline/assets/animations',
        },
        attachments_per_skill: {
            ux: { types: ['image', 'video', 'animation'], formats: ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'] },
        },
        attachment_max_count: 5,
        attachment_max_size_bytes: 50 * 1024 * 1024,
        attachment_video_max_duration_s: 300,
        dedup_window_hours: 24,
        audit_file: '.pipeline/audit/deliverable-notifications.jsonl',
    };
}

test('CA-2 integración · ux con 2 PNGs en disco → notify produce dropfiles con attachments', () => {
    const tmp = mkTmpRoot();
    try {
        // Setup: 2 PNGs issue-scoped en el root de mockups (allowlist por default).
        const issue = 3647;
        writePng(path.join(tmp.root, '.pipeline/assets/mockups/3647/dashboard-actual-01.png'));
        writePng(path.join(tmp.root, '.pipeline/assets/mockups/3647/dashboard-esperado-01.png'));

        // Paso 1 — pulpo invoca el helper.
        const fsAttachments = helper.collectAttachmentsForSkill('ux', issue, 'criterios', {
            pipelineRoot: tmp.root,
        });
        assert.equal(fsAttachments.length, 2, 'helper debe encontrar los 2 PNGs');

        // Paso 2 — pulpo fusiona en r.attachments. YAML simulado mínimo.
        const yaml = {
            resultado: 'aprobado',
            notas: 'Mockups generados con éxito. Ver attachments adjuntos.',
            attachments: fsAttachments,
        };

        // Paso 3 — notify produce dropfiles en queue dir.
        const telegramQueueDir = path.join(tmp.root, '.pipeline/servicios/telegram/pendiente');
        fs.mkdirSync(telegramQueueDir, { recursive: true });

        const dropfiles = [];
        const result = dn.notify({
            issue,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml,
            title: 'Issue de prueba',
            config: defaultCfg(),
            pipelineRoot: tmp.root,
            telegramQueueDir,
            deps: {
                writeQueueFile: (p, payload) => {
                    fs.mkdirSync(path.dirname(p), { recursive: true });
                    fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
                    dropfiles.push({ path: p, payload });
                },
                now: () => Date.now(),
            },
        });

        assert.equal(result.ok, true, `notify falló: ${JSON.stringify(result)}`);

        // Paso 4 — verificación: el flujo multi-attachment emite 1 dropfile
        // de texto + 1 dropfile por cada adjunto aceptado. Los dropfiles de
        // adjunto traen el path en el campo `photo:` (CA-UX-EXT-4 + mapping
        // ATTACHMENT_DROPFILE_FIELD del notifier).
        const photoDropfiles = dropfiles.filter((d) => d.payload && typeof d.payload.photo === 'string');
        assert.equal(photoDropfiles.length, 2,
            `esperaba 2 dropfiles con photo:, hubo ${photoDropfiles.length}. ` +
            `dropfiles=${JSON.stringify(dropfiles.map((d) => Object.keys(d.payload || {})))}`);

        // Ambos PNGs deben aparecer en los dropfiles (validateAttachmentPath +
        // verifyMagicBytes pasaron).
        const photoPaths = photoDropfiles.map((d) => d.payload.photo);
        assert.ok(photoPaths.some((p) => p.includes('dashboard-actual-01.png')),
            `falta dashboard-actual-01.png: ${photoPaths.join(', ')}`);
        assert.ok(photoPaths.some((p) => p.includes('dashboard-esperado-01.png')),
            `falta dashboard-esperado-01.png: ${photoPaths.join(', ')}`);

        // Y debe haber exactamente 1 dropfile de texto (CA-UX-EXT-4).
        const textDropfiles = dropfiles.filter((d) => d.payload && typeof d.payload.text === 'string');
        assert.equal(textDropfiles.length, 1, `esperaba 1 dropfile de texto, hubo ${textDropfiles.length}`);
    } finally {
        tmp.cleanup();
    }
});

test('CA-6 regresión · sin archivos en disco, helper devuelve [] y notify cae al text-only', () => {
    const tmp = mkTmpRoot();
    try {
        const issue = 9999;
        // No escribimos PNGs — helper no encuentra nada.
        const fsAttachments = helper.collectAttachmentsForSkill('ux', issue, 'criterios', {
            pipelineRoot: tmp.root,
        });
        assert.deepEqual(fsAttachments, []);

        // YAML sin attachments declarados.
        const yaml = {
            resultado: 'aprobado',
            notas: 'Sin assets visuales — fase analítica solamente.',
        };

        const telegramQueueDir = path.join(tmp.root, '.pipeline/servicios/telegram/pendiente');
        fs.mkdirSync(telegramQueueDir, { recursive: true });

        const dropfiles = [];
        const result = dn.notify({
            issue,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml,
            title: 'Issue de prueba sin assets',
            config: defaultCfg(),
            pipelineRoot: tmp.root,
            telegramQueueDir,
            deps: {
                writeQueueFile: (p, payload) => {
                    dropfiles.push({ path: p, payload });
                },
                now: () => Date.now(),
            },
        });

        assert.equal(result.ok, true, 'notify text-only debe funcionar sin attachments');

        // Sólo el dropfile de texto.
        assert.equal(dropfiles.length, 1, 'debe haber exactamente 1 dropfile (texto)');
        const textDropfile = dropfiles[0].payload;
        assert.ok(typeof textDropfile.text === 'string' && textDropfile.text.length > 0,
            `dropfile no parece ser texto: ${JSON.stringify(textDropfile)}`);
    } finally {
        tmp.cleanup();
    }
});

test('CA-FN-4 fallback · si el helper devuelve un path inválido, notify lo descarta sin romper', () => {
    const tmp = mkTmpRoot();
    try {
        const issue = 3647;
        // Simulamos un YAML con attachment fuera del allowlist (paths fuera del root).
        // El helper actual NO produce esto, pero el caller podría agregar al merger.
        const yaml = {
            resultado: 'aprobado',
            notas: 'Test fallback.',
            attachments: [
                { type: 'image', path: '/etc/passwd' },           // fuera de root
                { type: 'image', path: '../../escape/foo.png' },  // path traversal
            ],
        };

        const telegramQueueDir = path.join(tmp.root, '.pipeline/servicios/telegram/pendiente');
        fs.mkdirSync(telegramQueueDir, { recursive: true });

        const dropfiles = [];
        const result = dn.notify({
            issue,
            skill: 'ux',
            fase: 'criterios',
            pipeline: 'definicion',
            yaml,
            title: 'Issue de prueba fallback',
            config: defaultCfg(),
            pipelineRoot: tmp.root,
            telegramQueueDir,
            deps: {
                writeQueueFile: (p, payload) => { dropfiles.push({ path: p, payload }); },
                now: () => Date.now(),
            },
        });

        // notify NO debe abortar — debe caer al text-only y devolver ok=true.
        assert.equal(result.ok, true, `fallback text-only debe ok=true, vino: ${JSON.stringify(result)}`);
        assert.equal(dropfiles.length, 1, 'sólo el dropfile de texto debe estar presente');
    } finally {
        tmp.cleanup();
    }
});
