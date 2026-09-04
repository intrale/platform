// =============================================================================
// Tests del camino video→Drive→link (#3927 / EP3-H1)
//
// Cubre:
//   CA-1 — video que excede límites de Telegram se encola a servicios/drive/pendiente/
//   CA-2 — el encolado NO se reintenta además como adjunto Telegram (no doble envío)
//   CA-3 — fallo terminal de svc-drive SIEMPRE notifica a Telegram
//   CA-4 — test de integración con upload mockeado (no toca Drive productivo)
//   RS-1 — el job persiste pasado por sanitizeDrivePayload/sanitizeDriveFilename
//   RS-2 — path containment en resolveVideoPath (rechaza ../ y absolutos fuera del proyecto)
//   RS-3 — mensaje de fallo redactado (nunca err crudo)
//
// Convención: sin credenciales, sin videos reales, sin red. Todo en temp dirs.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Sandbox para servicio-drive: sus constantes (PROJECT_ROOT, ALLOWED_VIDEO_DIRS,
// cola de Telegram) se computan AL REQUERIR el módulo a partir de estas envs.
// Por eso se setean ANTES del require. PROJECT_ROOT = parent de PIPELINE_STATE_DIR.
// -----------------------------------------------------------------------------
const SVC_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-drive-proj-'));
process.env.PIPELINE_STATE_DIR = path.join(SVC_PROJECT, '.pipeline');
process.env.PIPELINE_DIR_OVERRIDE = path.join(SVC_PROJECT, '.pipeline');
fs.mkdirSync(process.env.PIPELINE_STATE_DIR, { recursive: true });

const dn = require('../deliverable-notify');
const drive = require('../../servicio-drive');
const { buildPreview, notify } = dn.__forTests__;

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const MP4_SIGNATURE = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'utf8'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2', 'utf8'),
]);

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-drive-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function writeVideoFixture(absPath, totalBytes) {
    const total = totalBytes || (MP4_SIGNATURE.length + 32);
    const padding = Buffer.alloc(Math.max(0, total - MP4_SIGNATURE.length), 0);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.concat([MP4_SIGNATURE, padding]));
}

// Config con límite de tamaño MINÚSCULO para forzar `size_exceeded` sin escribir
// fixtures de 50 MB. El video igual lleva magic bytes MP4 válidos.
function cfgWithTinyVideoLimit(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        skills: ['ux', 'qa'],
        truncate_chars: 1500,
        // #3931 — sin `attachment_root` legacy; `video` → qa/evidence (B9);
        // ux sin `animation`/`.gif` (sin productor real).
        attachment_roots: {
            document:  '.pipeline/assets/docs',
            image:     '.pipeline/assets/mockups',
            video:     'qa/evidence',
        },
        attachments_per_skill: {
            ux: { types: ['image', 'video'], formats: ['.png', '.jpg', '.jpeg', '.mp4', '.webm'] },
            qa: { types: ['video', 'document'], formats: ['.mp4', '.webm', '.pdf'] },
        },
        attachment_max_count: 5,
        attachment_max_size_bytes: 64, // ← cualquier video real lo excede
        attachment_video_max_duration_s: 300,
        dedup_window_hours: 24,
        audit_file: '.pipeline/audit/deliverable-notifications.jsonl',
    }, overrides || {});
}

function buildArgs(root, videoRelPath, extra) {
    return Object.assign({
        issue: '3927',
        skill: 'ux',
        fase: 'validacion',
        pipeline: 'desarrollo',
        title: 'EP3-H1 video share',
        pipelineRoot: root,
        config: cfgWithTinyVideoLimit(),
        yaml: {
            resultado: 'aprobado',
            notas: 'Video QA del flujo de encolado a Drive.',
            attachments: [{ type: 'video', path: videoRelPath }],
        },
    }, extra || {});
}

// -----------------------------------------------------------------------------
// CA-1 / RS-1 — buildPreview encola el video rechazado por tamaño
// -----------------------------------------------------------------------------

test('CA-1 · video size_exceeded produce un driveJob con schema { file, issue, title }', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/3927/3927.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const built = buildPreview(buildArgs(root, rel));

        assert.equal(Array.isArray(built.driveJobs), true, 'driveJobs debe existir');
        assert.equal(built.driveJobs.length, 1, 'debe haber exactamente 1 job de Drive');

        const payload = built.driveJobs[0].payload;
        assert.equal(typeof payload.file, 'string');
        assert.ok(payload.file.length > 0, 'file no debe ser vacío');
        assert.equal(payload.issue, 3927, 'issue debe ser numérico');
        assert.equal(payload.title, 'EP3-H1 video share');
    } finally {
        cleanup();
    }
});

test('RS-1 · el payload del job pasó por sanitizeDrivePayload (description/title sanitizados)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/3927/3927.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        // title con caracteres de control: el sanitizer debe limpiarlos.
        const args = buildArgs(root, rel, { title: 'Titulo\u0000con\u0007control' });
        const built = buildPreview(args);
        const payload = built.driveJobs[0].payload;

        assert.equal(/[\u0000-\u0008]/.test(payload.title), false, 'title no debe tener chars de control');
        assert.equal(typeof payload.description, 'string');
    } finally {
        cleanup();
    }
});

test('RS-1 · basename con secreto → filename saneado (sanitizeDriveFilename)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // AWS access key embebida en el nombre del archivo.
        const rel = 'qa/evidence/3927/qa-AKIAIOSFODNN7EXAMPLE-video.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const built = buildPreview(buildArgs(root, rel));
        const payload = built.driveJobs[0].payload;

        assert.equal(/AKIAIOSFODNN7EXAMPLE/.test(payload.filename), false,
            'el filename no debe exponer la AWS key');
        assert.match(payload.filename, /^redacted-[0-9a-f]{8}\.mp4$/,
            'filename debe ser redacted-<hash>.mp4');
    } finally {
        cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-2 — el video encolado NO se reintenta como adjunto Telegram
// -----------------------------------------------------------------------------

test('CA-2 · el video encolado NO aparece en extraDropfiles (no doble envío)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/3927/3927.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const built = buildPreview(buildArgs(root, rel));
        const extra = built.extraDropfiles || [];

        // Ningún dropfile debe llevar el video como adjunto.
        const leaks = extra.filter((d) => d && (d.video || (typeof d.document === 'string' && d.document.includes('3927.mp4'))));
        assert.equal(leaks.length, 0, 'el video encolado no debe enviarse también por Telegram');
        // Y el payload principal tampoco lo incluye como video.
        assert.equal(built.payload.video == null, true);
    } finally {
        cleanup();
    }
});

test('CA-2 · footer informa el encolado de forma forward-looking', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/3927/3927.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const built = buildPreview(buildArgs(root, rel));
        const text = built.payload.text || built.payload.caption || '';
        assert.match(text, /Drive/, 'el mensaje debe mencionar que sube a Drive');
    } finally {
        cleanup();
    }
});

// -----------------------------------------------------------------------------
// CA-1 (write) — notify() persiste el job en servicios/drive/pendiente/
// -----------------------------------------------------------------------------

test('CA-1 · notify() escribe el job en la cola de Drive con JSON válido', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/3927/3927.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const telegramQueueDir = path.join(root, '.pipeline/servicios/telegram/pendiente');
        const driveQueueDir = path.join(root, '.pipeline/servicios/drive/pendiente');
        fs.mkdirSync(telegramQueueDir, { recursive: true });

        const out = notify(Object.assign(buildArgs(root, rel), {
            telegramQueueDir,
            driveQueueDir,
            deps: { now: () => 1000 },
        }));

        assert.equal(out.ok, true, `notify debe encolar OK (reason: ${out.reason})`);
        assert.equal(Array.isArray(out.driveJobs), true);
        assert.equal(out.driveJobs.length, 1);

        const files = fs.readdirSync(driveQueueDir).filter((f) => f.endsWith('.json'));
        assert.equal(files.length, 1, 'debe haber 1 job en la cola de Drive');

        const job = JSON.parse(fs.readFileSync(path.join(driveQueueDir, files[0]), 'utf8'));
        assert.equal(typeof job.file, 'string');
        assert.equal(job.issue, 3927);
        assert.equal(typeof job.title, 'string');
    } finally {
        cleanup();
    }
});

// -----------------------------------------------------------------------------
// RS-2 — containment de resolveVideoPath (servicio-drive)
// -----------------------------------------------------------------------------

test('RS-2 · resolveVideoPath acepta un video dentro de qa/evidence/', () => {
    const evidenceVideo = path.join(SVC_PROJECT, 'qa', 'evidence', '3927', 'video.mp4');
    writeVideoFixture(evidenceVideo, 128);

    const resolved = drive.resolveVideoPath('qa/evidence/3927/video.mp4');
    assert.equal(resolved, path.resolve(evidenceVideo), 'debe resolver dentro de qa/evidence');
});

// #6497 — el containment se movió de `resolveVideoPath` a `resolveConfinedEvidence`,
// que es ahora el PUNTO ÚNICO por el que pasan TODAS las vías (video y
// estructural). `resolveVideoPath` quedó como resolución + fallbacks pura: si
// siguiera confinando, sería imposible distinguir "no promovido" de "fuera del
// allowlist" (CA-UX-2) y no habría dónde correr el guard para el modo
// estructural (CA-4). La conducta de RS-2 se conserva intacta, sólo cambia el
// punto de entrada: estos tests apuntan al guard nuevo.

test('RS-2 · el containment rechaza un archivo existente FUERA de los dirs permitidos', () => {
    // Archivo real bajo PROJECT_ROOT pero NO en un directorio de evidencia.
    const outside = path.join(SVC_PROJECT, 'secret.txt');
    fs.writeFileSync(outside, 'no-subir-esto');

    const confined = drive.resolveConfinedEvidence('secret.txt');
    assert.equal(confined.ok, false, 'no debe aceptar archivos fuera del allowlist de evidencia');
    assert.equal(confined.reason, drive.REJECT_FUERA_ALLOWLIST,
        'existe pero está fuera: es el motivo de seguridad, no el operativo');
});

test('RS-2 · el containment rechaza un absoluto fuera del proyecto', () => {
    const outsideAbs = path.join(os.tmpdir(), `rs2-outside-${process.pid}.mp4`);
    writeVideoFixture(outsideAbs, 128);
    try {
        const confined = drive.resolveConfinedEvidence(outsideAbs);
        assert.equal(confined.ok, false, 'no debe aceptar absolutos fuera del proyecto');
        assert.equal(confined.reason, drive.REJECT_FUERA_ALLOWLIST);
    } finally {
        try { fs.rmSync(outsideAbs, { force: true }); } catch {}
    }
});

test('RS-2 · el containment rechaza traversal con ../', () => {
    // Crear un archivo real al que un ../ intentaría escapar.
    const escapeTarget = path.join(path.dirname(SVC_PROJECT), `rs2-escape-${process.pid}.mp4`);
    writeVideoFixture(escapeTarget, 128);
    try {
        const confined = drive.resolveConfinedEvidence(`../${path.basename(escapeTarget)}`);
        assert.equal(confined.ok, false, 'el traversal ../ debe rechazarse');
        assert.equal(confined.reason, drive.REJECT_FUERA_ALLOWLIST);
    } finally {
        try { fs.rmSync(escapeTarget, { force: true }); } catch {}
    }
});

// -----------------------------------------------------------------------------
// CA-3 / RS-3 — fallo SIEMPRE notifica, con mensaje redactado
// -----------------------------------------------------------------------------

test('CA-3 / RS-3 · notifyDriveFailure escribe alerta Telegram con el secreto redactado', () => {
    const telegramDir = path.join(process.env.PIPELINE_DIR_OVERRIDE, 'servicios', 'telegram', 'pendiente');
    // Limpiar la cola antes de la aserción.
    try { fs.rmSync(telegramDir, { recursive: true, force: true }); } catch {}

    drive.notifyDriveFailure('3927', 'fallo subiendo: token AKIAIOSFODNN7EXAMPLE expuesto');

    const files = fs.existsSync(telegramDir)
        ? fs.readdirSync(telegramDir).filter((f) => f.endsWith('.json'))
        : [];
    assert.equal(files.length >= 1, true, 'debe escribir una alerta a Telegram (nunca silencio)');

    const content = fs.readFileSync(path.join(telegramDir, files[0]), 'utf8');
    assert.equal(/AKIAIOSFODNN7EXAMPLE/.test(content), false,
        'la AWS key NO debe aparecer cruda en la alerta');
    assert.match(content, /3927/, 'la alerta debe referenciar el issue');
});

// -----------------------------------------------------------------------------
// #4514 CA-5 — gate `sensible`: un artefacto sensible NUNCA se encola a Drive
// público, aunque exceda los límites de Telegram. Se omite con footer explícito.
// -----------------------------------------------------------------------------

test('#4514 CA-5 · adjunto sensible que excede tamaño NO genera driveJob (gate)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/4514/security-report.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const args = buildArgs(root, rel);
        // El reporte de auditoría es sensible: el índice lo marca y el flag viaja
        // por `attachments[]` hasta el record. Excede el límite (64 bytes) → sería
        // encolable a Drive, pero el gate lo bloquea.
        args.yaml.attachments = [{ type: 'video', path: rel, sensible: true }];

        const built = buildPreview(args);

        assert.equal(built.driveJobs.length, 0, 'un adjunto sensible NUNCA se encola a Drive público');
        assert.equal(built.sensibleBlocked.length, 1, 'debe quedar registrado como bloqueado por sensible');
    } finally {
        cleanup();
    }
});

test('#4514 CA-5 · el footer del artefacto sensible es explícito y no promete subida a Drive', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/4514/security-report.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const args = buildArgs(root, rel);
        args.yaml.attachments = [{ type: 'video', path: rel, sensible: true }];

        const built = buildPreview(args);
        const text = built.payload.text || built.payload.caption || '';

        assert.match(text, /sensible/i, 'el footer debe avisar que es un reporte sensible');
        assert.doesNotMatch(text, /subiendo a Drive|el link llega en breve/i,
            'no debe prometer subida a Drive para un artefacto sensible');
    } finally {
        cleanup();
    }
});

test('#4514 CA-5 · regresión: video NO sensible que excede tamaño SÍ se encola a Drive', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rel = 'qa/evidence/4514/qa-run.mp4';
        writeVideoFixture(path.join(root, rel), 600);

        const args = buildArgs(root, rel);
        // Sin flag `sensible` → comportamiento histórico intacto (encola a Drive).
        args.yaml.attachments = [{ type: 'video', path: rel }];

        const built = buildPreview(args);
        assert.equal(built.driveJobs.length, 1, 'el video no sensible debe seguir encolándose a Drive');
        assert.equal(built.sensibleBlocked.length, 0);
    } finally {
        cleanup();
    }
});

test('QA estructural · reconoce únicamente el schema canónico exento de video', () => {
    assert.equal(drive.isStructuralEvidenceJob({
        mode: 'structural',
        source: 'qa-structural',
    }), true);
    assert.equal(drive.isStructuralEvidenceJob({
        mode: 'structural',
        source: 'otro',
    }), false);
    assert.equal(drive.isStructuralEvidenceJob({
        mode: 'android',
        source: 'qa-structural',
    }), false);
});

test('QA estructural · processJob mueve el Markdown a listo sin invocar el uploader', async () => {
    const queueRoot = path.join(process.env.PIPELINE_STATE_DIR, 'servicios', 'drive');
    const pendiente = path.join(queueRoot, 'pendiente');
    const trabajando = path.join(queueRoot, 'trabajando');
    const listo = path.join(queueRoot, 'listo');
    const fallido = path.join(queueRoot, 'fallido');
    for (const dir of [pendiente, trabajando, listo, fallido]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // #6497 — el artefacto tiene que EXISTIR en la ruta canónica: desde que el
    // descriptor lleva sello, un job estructural cuyo archivo no está promovido
    // ya no pasa de largo a `listo/` (iría a `fallido/` con motivo "no
    // promovido"). `.pipeline/assets/docs/**` está en el allowlist ampliado
    // (R-4) porque es lo que produce realmente `deliverable-notify`.
    const evidencia = path.join(SVC_PROJECT, '.pipeline', 'assets', 'docs', '4899', 'qa-verificacion-4899.md');
    fs.mkdirSync(path.dirname(evidencia), { recursive: true });
    fs.writeFileSync(evidencia, '# QA verificacion 4899\n');

    const name = 'qa-4899-structural.json';
    const jobPath = path.join(pendiente, name);
    fs.writeFileSync(jobPath, JSON.stringify({
        action: 'upload',
        file: '.pipeline/assets/docs/4899/qa-verificacion-4899.md',
        issue: 4899,
        mode: 'structural',
        source: 'qa-structural',
    }));

    await drive.processJob({ name, path: jobPath });

    assert.equal(fs.existsSync(path.join(listo, name)), true);
    assert.equal(fs.existsSync(path.join(fallido, name)), false);
    assert.equal(fs.existsSync(path.join(trabajando, name)), false);

    // #6497 CA-1 — y llega sellado: el descriptor es la identidad autoritativa
    // del artefacto, que es efímero.
    const sellado = JSON.parse(fs.readFileSync(path.join(listo, name), 'utf8'));
    assert.match(sellado.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(sellado.bytes, fs.statSync(evidencia).size);
});

// -----------------------------------------------------------------------------
// limpieza del sandbox de servicio-drive
// -----------------------------------------------------------------------------
test.after(() => {
    try { fs.rmSync(SVC_PROJECT, { recursive: true, force: true }); } catch {}
});
