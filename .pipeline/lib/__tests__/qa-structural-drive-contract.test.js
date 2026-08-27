// =============================================================================
// Contrato del descriptor de Drive del QA estructural.
//
// #6497 — antes este archivo sólo hacía `assert.match` sobre el texto de
// `roles/qa.md`: verificaba la DOCUMENTACIÓN, no el comportamiento. Ahora
// asserta sobre el descriptor y el schema REALES de `servicio-drive.js`:
//
//   CA-1 — el registro de subida incluye `sha256` (`sha256:<64 hex>`) y `bytes`
//          (entero > 0), y la validación RECHAZA un descriptor sin ellos.
//   CA-2 — el hash se computa LOCAL sobre los bytes del archivo, antes de subir.
//   CA-3 — ruta canónica única; los derivados arrastran el puntero.
//   CA-4 — la vía estructural pasa por el containment ANTES del early-return:
//          traversal relativo, absoluto fuera del repo y symlink que sale del
//          allowlist van a FALLIDO + notifyDriveFailure, con CERO hasheo.
//   CA-5 — sólo obtiene hash lo que pasó el guard.
//   CA-6 — el sello lo deriva el pipeline; lo que declara el agente se descarta.
//   CA-UX-1/2/3 — el aviso nombra el artefacto real, distingue las dos causas y
//          agrupa por ciclo.
//
// Convención: sin credenciales, sin red, todo en temp dirs.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// -----------------------------------------------------------------------------
// Sandbox: servicio-drive computa PROJECT_ROOT y ALLOWED_EVIDENCE_DIRS AL
// REQUERIRSE, a partir de estas envs. Se setean ANTES del require.
// -----------------------------------------------------------------------------
const SVC_PROJECT = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'drive-contract-')),
);
process.env.PIPELINE_STATE_DIR = path.join(SVC_PROJECT, '.pipeline');
process.env.PIPELINE_DIR_OVERRIDE = path.join(SVC_PROJECT, '.pipeline');
fs.mkdirSync(process.env.PIPELINE_STATE_DIR, { recursive: true });

const drive = require('../../servicio-drive');

const QUEUE = path.join(SVC_PROJECT, '.pipeline', 'servicios', 'drive');
const PENDIENTE = path.join(QUEUE, 'pendiente');
const TRABAJANDO = path.join(QUEUE, 'trabajando');
const LISTO = path.join(QUEUE, 'listo');
const FALLIDO = path.join(QUEUE, 'fallido');
const TELEGRAM_QUEUE = path.join(SVC_PROJECT, '.pipeline', 'servicios', 'telegram', 'pendiente');

for (const d of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) fs.mkdirSync(d, { recursive: true });

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function writeEvidence(relPath, content) {
    const abs = path.join(SVC_PROJECT, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

function structuralJob(issue, file, extra) {
    return Object.assign({
        action: 'upload',
        file,
        issue,
        mode: 'structural',
        source: 'qa-structural',
    }, extra || {});
}

// Encola un job y lo procesa. Devuelve dónde terminó y con qué contenido.
async function runJob(name, payload) {
    for (const d of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) fs.mkdirSync(d, { recursive: true });
    const src = path.join(PENDIENTE, name);
    fs.writeFileSync(src, JSON.stringify(payload, null, 2));
    await drive.processJob({ name, path: src });
    const read = (dir) => {
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) return null;
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
    };
    return {
        listo: read(LISTO),
        fallido: read(FALLIDO),
        pendiente: read(PENDIENTE),
    };
}

function clearTelegramQueue() {
    try { fs.rmSync(TELEGRAM_QUEUE, { recursive: true, force: true }); } catch { /* noop */ }
}

function telegramMessages() {
    if (!fs.existsSync(TELEGRAM_QUEUE)) return [];
    return fs.readdirSync(TELEGRAM_QUEUE)
        .filter((f) => f.endsWith('.json'))
        .map((f) => fs.readFileSync(path.join(TELEGRAM_QUEUE, f), 'utf8'));
}

function sha256Of(buf) {
    return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

// =============================================================================
// Documentación del contrato (CA-6) — se conserva lo que ya verificaba el test
// =============================================================================

const qaRole = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'roles', 'qa.md'),
    'utf8',
);

test('QA estructural exige evidencia auditable y descriptor canonico en Drive', () => {
    assert.match(qaRole, /qa-<issue>-structural\.md/);
    assert.match(qaRole, /servicios\/drive\/pendiente\/qa-<issue>-structural\.json/);
    assert.match(qaRole, /"mode": "structural"/);
    assert.match(qaRole, /"source": "qa-structural"/);
});

test('CA-6 · roles/qa.md documenta el contrato del sello en los tres modos', () => {
    // Hoy (pre-#6497) `grep -c "sha256" .pipeline/roles/qa.md` daba 0.
    const ocurrencias = (qaRole.match(/sha256/g) || []).length;
    assert.ok(ocurrencias >= 3, `roles/qa.md debe documentar el sello (sha256 x${ocurrencias})`);

    // Los tres modos tienen su nota: api, structural, android.
    assert.match(qaRole, /modo `api`/);
    assert.match(qaRole, /modo `structural`/);
    assert.match(qaRole, /modo `android`/);

    // Y en los tres dice que lo deriva el pipeline y que lo del agente se descarta.
    const derivaPipeline = (qaRole.match(/deriva el pipeline/g) || []).length;
    assert.ok(derivaPipeline >= 3, `los 3 modos deben decir que lo deriva el pipeline (${derivaPipeline})`);
    const seDescarta = (qaRole.match(/se descarta/g) || []).length;
    assert.ok(seDescarta >= 3, `los 3 modos deben decir que lo declarado se descarta (${seDescarta})`);
});

test('CA-7 · .gitattributes cubre qa/evidence/** con -text', () => {
    const attrs = fs.readFileSync(
        path.resolve(__dirname, '..', '..', '..', '.gitattributes'),
        'utf8',
    );
    assert.match(attrs, /^qa\/evidence\/\*\* -text$/m,
        'sin `-text`, un checkout en otra plataforma normaliza CRLF y el sha256 sellado deja de matchear');
});

// =============================================================================
// CA-1 — el descriptor emitido incluye sha256 y bytes, y el schema los EXIGE
// =============================================================================

test('CA-1 · el descriptor estructural emitido incluye sha256 y bytes', async () => {
    const contenido = Buffer.from('# QA estructural 6497\n\n$ node --check ok\n', 'utf8');
    writeEvidence('qa/evidence/6497/qa-6497-structural.md', contenido);

    const { listo, fallido } = await runJob(
        'qa-6497-structural.json',
        structuralJob(6497, 'qa/evidence/6497/qa-6497-structural.md'),
    );

    assert.equal(fallido, null, 'un job estructural legítimo no debe ir a fallido');
    assert.ok(listo, 'el descriptor sellado debe quedar en listo/');
    assert.match(listo.sha256, /^sha256:[0-9a-f]{64}$/, 'sha256 con formato canónico');
    assert.equal(Number.isInteger(listo.bytes) && listo.bytes > 0, true, 'bytes entero > 0');
    assert.equal(listo.bytes, contenido.length, 'bytes = tamaño real del artefacto');
});

test('CA-1 · el schema RECHAZA un descriptor sin sha256 o sin bytes', () => {
    const base = structuralJob(6497, 'qa/evidence/6497/qa-6497-structural.md');

    assert.throws(() => drive.assertSealedStructuralJob(Object.assign({}, base)),
        /sha256/, 'sin sha256 debe rechazar');
    assert.throws(
        () => drive.assertSealedStructuralJob(Object.assign({}, base, { sha256: 'sha256:corto' })),
        /sha256/, 'un sha256 malformado debe rechazar');
    assert.throws(
        () => drive.assertSealedStructuralJob(Object.assign({}, base, { sha256: 'sha256:' + 'a'.repeat(64) })),
        /bytes/, 'sin bytes debe rechazar');
    assert.throws(
        () => drive.assertSealedStructuralJob(
            Object.assign({}, base, { sha256: 'sha256:' + 'a'.repeat(64), bytes: 0 }),
        ),
        /bytes/, 'bytes = 0 no es evidencia');
    assert.equal(
        drive.assertSealedStructuralJob(
            Object.assign({}, base, { sha256: 'sha256:' + 'a'.repeat(64), bytes: 12 }),
        ),
        true,
        'un descriptor sellado completo pasa',
    );
});

// =============================================================================
// CA-2 — el hash se computa LOCAL, sobre los bytes del archivo
// =============================================================================

test('CA-2 · el sha256 del descriptor es el de los bytes locales del artefacto', async () => {
    const contenido = Buffer.from('bytes locales, no leidos de Drive\n', 'utf8');
    writeEvidence('qa/evidence/6001/qa-6001-structural.md', contenido);

    const { listo } = await runJob(
        'qa-6001-structural.json',
        structuralJob(6001, 'qa/evidence/6001/qa-6001-structural.md'),
    );

    assert.equal(listo.sha256, sha256Of(contenido),
        'el hash debe derivarse de los bytes en disco (SEC-10: nunca releerlo desde Drive)');
});

// =============================================================================
// CA-6 — el sello lo deriva el pipeline: lo declarado por el agente se descarta
// =============================================================================

test('CA-6 · un sha256 declarado por el agente es descartado y recomputado', async () => {
    const contenido = Buffer.from('contenido real distinto del declarado\n', 'utf8');
    writeEvidence('qa/evidence/6002/qa-6002-structural.md', contenido);

    const mentira = 'sha256:' + 'f'.repeat(64);
    const { listo } = await runJob(
        'qa-6002-structural.json',
        structuralJob(6002, 'qa/evidence/6002/qa-6002-structural.md', {
            sha256: mentira,
            bytes: 999999,
        }),
    );

    assert.notEqual(listo.sha256, mentira, 'el hash declarado por el agente NO puede sobrevivir');
    assert.equal(listo.sha256, sha256Of(contenido));
    assert.equal(listo.bytes, contenido.length, 'los bytes declarados también se recomputan');
});

// =============================================================================
// CA-3 — ruta canónica única
// =============================================================================

test('CA-3 · el descriptor sellado lleva la ruta canónica relativa al repo', async () => {
    writeEvidence('qa/evidence/6003/qa-6003-structural.md', 'canonica\n');

    const { listo } = await runJob(
        'qa-6003-structural.json',
        // Declarado como ABSOLUTO dentro del repo: la ruta canónica es la relativa.
        structuralJob(6003, path.join(SVC_PROJECT, 'qa', 'evidence', '6003', 'qa-6003-structural.md')),
    );

    assert.equal(listo.file, 'qa/evidence/6003/qa-6003-structural.md',
        'file pasa a ser LA ruta canónica (relativa, separador POSIX)');
    assert.ok(listo.file_declarado, 'la ruta declarada queda para trazabilidad cuando difiere');
});

// =============================================================================
// CA-4 — la vía estructural pasa por el containment ANTES del early-return
// =============================================================================

test('CA-4 · la vía estructural rechaza un traversal relativo antes del early-return', async () => {
    // El objetivo del traversal existe y es de baja entropía: exactamente el
    // caso del PoC (oráculo de contenido por fuerza bruta offline).
    const secreto = path.join(path.dirname(SVC_PROJECT), `contract-secret-${process.pid}.json`);
    fs.writeFileSync(secreto, '{"token":"no-exfiltrar"}');
    clearTelegramQueue();
    try {
        const { listo, fallido } = await runJob(
            'qa-6004-structural.json',
            structuralJob(6004, `qa/evidence/6004/../../../${path.basename(secreto)}`),
        );

        assert.equal(listo, null, 'un traversal NUNCA puede llegar a listo/');
        assert.ok(fallido, 'debe ir a fallido/');
        // CA-5: cero hasheo de lo que no pasó el guard.
        assert.equal(fallido.sha256, undefined, 'no se publica hash de lo que no pasó el guard');
        assert.equal(fallido.bytes, undefined);
        assert.ok(telegramMessages().length >= 1, 'debe notificar (nunca silencio)');
    } finally {
        try { fs.rmSync(secreto, { force: true }); } catch { /* noop */ }
    }
});

test('CA-4 · la vía estructural rechaza un absoluto fuera del repo', async () => {
    const afuera = path.join(os.tmpdir(), `contract-outside-${process.pid}.md`);
    fs.writeFileSync(afuera, 'afuera del repo\n');
    clearTelegramQueue();
    try {
        const { listo, fallido } = await runJob(
            'qa-6005-structural.json',
            structuralJob(6005, afuera),
        );

        assert.equal(listo, null, 'un absoluto fuera del repo NUNCA puede llegar a listo/');
        assert.ok(fallido, 'debe ir a fallido/');
        assert.equal(fallido.sha256, undefined, 'CA-5: sin hash informativo');
    } finally {
        try { fs.rmSync(afuera, { force: true }); } catch { /* noop */ }
    }
});

test('CA-4 · el containment resuelve symlinks (realpath), no sólo path.resolve', async (t) => {
    const objetivo = path.join(path.dirname(SVC_PROJECT), `contract-linked-${process.pid}.md`);
    fs.writeFileSync(objetivo, 'destino del symlink, fuera del allowlist\n');
    const linkDir = path.join(SVC_PROJECT, 'qa', 'evidence', '6006');
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, 'qa-6006-structural.md');

    let linkCreado = false;
    try {
        fs.symlinkSync(objetivo, link, 'file');
        linkCreado = true;
    } catch {
        // El sandbox puede denegar la creación del link (Windows sin privilegio
        // de symlink). No se saltea el test: se stubea `fs.realpathSync` para
        // que devuelva el destino real, que es lo que el guard debe mirar.
        fs.writeFileSync(link, 'placeholder');
        const original = fs.realpathSync;
        t.mock.method(fs, 'realpathSync', function stubbed(p, ...rest) {
            if (path.resolve(p) === path.resolve(link)) return objetivo;
            return original.call(fs, p, ...rest);
        });
    }

    try {
        // Léxicamente el path cae DENTRO de qa/evidence/6006/ — es justo el caso
        // que el containment viejo (path.resolve + startsWith) dejaba pasar.
        assert.equal(
            drive.isWithinAllowedEvidenceDir(link),
            false,
            'un symlink que sale del allowlist debe rechazarse aunque sea léxicamente interno',
        );

        const { listo, fallido } = await runJob(
            'qa-6006-structural.json',
            structuralJob(6006, 'qa/evidence/6006/qa-6006-structural.md'),
        );
        assert.equal(listo, null, 'el symlink que escapa NUNCA puede llegar a listo/');
        assert.ok(fallido, 'debe ir a fallido/');
        assert.equal(fallido.sha256, undefined, 'CA-5: sin hash del destino del symlink');
    } finally {
        try { fs.rmSync(link, { force: true }); } catch { /* noop */ }
        try { fs.rmSync(objetivo, { force: true }); } catch { /* noop */ }
        assert.equal(typeof linkCreado, 'boolean');
    }
});

test('CA-4 · un dropfile del pipeline NO es evidencia publicable y va a fallido', async () => {
    writeEvidence('.pipeline/desarrollo/verificacion/procesado/6007.qa', 'resultado: aprobado\n');

    const { listo, fallido } = await runJob(
        'qa-6007-structural.json',
        structuralJob(6007, '.pipeline/desarrollo/verificacion/procesado/6007.qa'),
    );

    assert.equal(listo, null, 'un dropfile del pipeline no se publica');
    assert.ok(fallido, 'debe ir a fallido/ y corregirse en el productor');
});

// =============================================================================
// R-1 / R-4 — la ampliación del allowlist y los fallbacks NO se rompen
// =============================================================================

test('R-1 · un job con basename suelto sigue resolviendo por qa/recordings', async () => {
    writeEvidence('qa/recordings/qa-6008.mp4', 'video-fixture');

    const confined = drive.resolveConfinedEvidence('qa-6008.mp4');
    assert.equal(confined.ok, true, 'el fallback por basename en qa/recordings debe seguir resolviendo');
    assert.equal(confined.canonical, 'qa/recordings/qa-6008.mp4');
});

test('R-4 · el allowlist ampliado acepta los productores reales de la cola', () => {
    const casos = [
        ['qa/evidence/4899/qa-4899.mp4', true],
        ['qa/evidence/qa-2017.mp4', true],                       // plano, sin subdir de issue
        ['qa/recordings/qa-1920.mp4', true],
        ['.pipeline/assets/docs/4899/qa-verificacion-4899.md', true],
        ['.pipeline/logs/media/qa-1881.mp4', true],
        ['docs/qa/reporte-1121-carrito-pedidos.pdf', true],
        ['.pipeline/desarrollo/verificacion/procesado/5244.qa', false],
        // Directorio oculto de estado del agente, fuera de todo dir de
        // evidencia. El guard es puramente posicional -- no mira el nombre del
        // archivo -- así que el fixture es un centinela neutro a propósito: no
        // hace falta (ni conviene) incrustar la ruta de un store real de
        // credenciales en la suite para cubrir exactamente la misma rama.
        ['.claude/state/fixture-fuera-de-alcance.json', false],
    ];
    for (const [rel, esperado] of casos) {
        writeEvidence(rel, 'x');
        assert.equal(
            drive.isWithinAllowedEvidenceDir(path.join(SVC_PROJECT, rel)),
            esperado,
            `${rel} debería ${esperado ? 'entrar' : 'quedar fuera'} del allowlist`,
        );
    }
});

test('R-4 · el rename de la constante mantiene el alias exportado', () => {
    assert.equal(drive.ALLOWED_VIDEO_DIRS, drive.ALLOWED_EVIDENCE_DIRS,
        'el nombre viejo debe apuntar a la MISMA lista, no a una copia divergente');
    assert.equal(drive.ALLOWED_EVIDENCE_DIRS.length, 5);
});

test('isUnderBase no confunde un hermano con prefijo común', () => {
    assert.equal(drive.isUnderBase('/repo/qa/evidence', '/repo/qa/evidence/6497/a.md'), true);
    assert.equal(drive.isUnderBase('/repo/qa/evidence', '/repo/qa/evidence-malicioso/a.md'), false);
    assert.equal(drive.isUnderBase('/repo/qa/evidence', '/repo/qa/evidence'), false);
});

// =============================================================================
// CA-UX-1 / CA-UX-2 — el aviso nombra el artefacto real y distingue las causas
// =============================================================================

test('CA-UX-1 · un job structural con .md produce un aviso que NO dice "video"', async () => {
    clearTelegramQueue();
    await runJob(
        'qa-6009-structural.json',
        structuralJob(6009, 'qa/evidence/6009/no-existe.md'),
    );

    const msgs = telegramMessages();
    assert.ok(msgs.length >= 1, 'debe notificar');
    const texto = msgs.join('\n');
    assert.equal(/video/i.test(texto), false,
        'un .md estructural NUNCA debe anunciarse como "el video" (manda al operador a buscar algo que no existe)');
    assert.match(texto, /evidencia estructural/i);
});

test('CA-UX-1 · describeArtifact deriva el tipo del mode y la extensión', () => {
    assert.equal(drive.describeArtifact({ mode: 'structural', file: 'qa/evidence/1/a.md' }).kind,
        'evidencia-estructural');
    assert.equal(drive.describeArtifact({ file: 'qa/evidence/1/a.mp4' }).kind, 'video');
    assert.equal(drive.describeArtifact({ file: 'docs/qa/a.pdf' }).kind, 'pdf');
    assert.equal(drive.describeArtifact({ file: '.pipeline/logs/media/a.xml' }).kind, 'xml');
    assert.equal(drive.describeArtifact({ file: 'qa/evidence/1/a.md' }).kind, 'markdown');
    assert.equal(drive.describeArtifact({}).kind, 'artefacto');
    assert.match(drive.describeArtifact({ file: 'qa/evidence/1/a.mp4' }).label, /video/);
});

test('CA-UX-2 · "no promovido" y "fuera del allowlist" son mensajes DISTINTOS', async () => {
    // (a) no promovido: la ruta es canónica pero el artefacto no existe.
    clearTelegramQueue();
    await runJob('qa-6010-structural.json', structuralJob(6010, 'qa/evidence/6010/nunca-promovido.md'));
    const noPromovido = telegramMessages().join('\n');

    // (b) fuera del allowlist: el artefacto existe, pero en un directorio no publicable.
    writeEvidence('.pipeline/desarrollo/verificacion/procesado/6011.qa', 'x');
    clearTelegramQueue();
    await runJob('qa-6011-structural.json', structuralJob(6011, '.pipeline/desarrollo/verificacion/procesado/6011.qa'));
    const fueraAllowlist = telegramMessages().join('\n');

    assert.match(noPromovido, /no promovido/i);
    assert.match(fueraAllowlist, /fuera de los directorios/i);
    assert.notEqual(noPromovido.replace(/6010/g, 'N'), fueraAllowlist.replace(/6011/g, 'N'),
        'dos causas con acciones humanas opuestas no pueden compartir el mismo texto');
});

test('CA-UX-2 · el texto del allowlist se DERIVA de ALLOWED_EVIDENCE_DIRS', () => {
    const hint = drive.allowlistHint();
    for (const dir of drive.ALLOWED_EVIDENCE_DIRS) {
        const rel = path.relative(drive.PROJECT_ROOT, dir).split(path.sep).join('/');
        assert.ok(hint.includes(rel), `el mensaje debe enumerar ${rel} sin hardcodearlo`);
    }
    // El string viejo hardcodeado enumeraba sólo dos directorios.
    assert.equal(hint.split(', ').length, drive.ALLOWED_EVIDENCE_DIRS.length);
});

// =============================================================================
// CA-UX-3 — un ciclo con N rechazos emite UN solo aviso agregado
// =============================================================================

test('CA-UX-3 · 3 jobs inválidos en un ciclo producen 1 sola notificación', async () => {
    for (const d of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) {
        fs.rmSync(d, { recursive: true, force: true });
        fs.mkdirSync(d, { recursive: true });
    }
    clearTelegramQueue();

    for (const issue of [7001, 7002, 7003]) {
        fs.writeFileSync(
            path.join(PENDIENTE, `qa-${issue}-structural.json`),
            JSON.stringify(structuralJob(issue, `qa/evidence/${issue}/no-existe.md`)),
        );
    }

    await drive.processQueue();

    const msgs = telegramMessages();
    assert.equal(msgs.length, 1,
        `3 rechazos en un ciclo = 1 aviso agregado, no ${msgs.length} (una ráfaga entrena al operador a ignorar el canal)`);
    assert.match(msgs[0], /3 jobs de Drive rechazados/);
    assert.match(msgs[0], /7001/);
    assert.match(msgs[0], /7003/);
    // CA-5 / R-7: ni un hash en el aviso.
    assert.equal(/sha256/.test(msgs[0]), false, 'el aviso NUNCA lleva hash');

    assert.equal(fs.readdirSync(FALLIDO).length, 3, 'los 3 van a fallido/');
});

test('CA-UX-3 · un ciclo con UN solo rechazo mantiene el aviso individual', async () => {
    for (const d of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) {
        fs.rmSync(d, { recursive: true, force: true });
        fs.mkdirSync(d, { recursive: true });
    }
    clearTelegramQueue();

    fs.writeFileSync(
        path.join(PENDIENTE, 'qa-7004-structural.json'),
        JSON.stringify(structuralJob(7004, 'qa/evidence/7004/no-existe.md')),
    );
    await drive.processQueue();

    const msgs = telegramMessages();
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /7004/);
    assert.match(msgs[0], /no promovido/i, 'con un solo rechazo el operador merece el motivo completo');
});

// =============================================================================
// CA-5 / R-7 — cero hasheo de lo que no pasó el guard
// =============================================================================

test('CA-5 · no se hashea NADA que no haya pasado resolveConfinedEvidence', async (t) => {
    const secreto = path.join(path.dirname(SVC_PROJECT), `contract-lowentropy-${process.pid}.txt`);
    fs.writeFileSync(secreto, 'si\n');   // baja entropía: fuerza-brutable offline
    const espia = t.mock.method(fs, 'readFileSync');
    try {
        await runJob(
            'qa-6012-structural.json',
            structuralJob(6012, `qa/evidence/6012/../../../${path.basename(secreto)}`),
        );
        const leyoElSecreto = espia.mock.calls.some((c) => {
            const arg = c.arguments && c.arguments[0];
            return typeof arg === 'string' && path.resolve(arg) === path.resolve(secreto);
        });
        assert.equal(leyoElSecreto, false,
            'un sha256 de archivo de baja entropía que no pasó el guard es publicar el secreto');
    } finally {
        try { fs.rmSync(secreto, { force: true }); } catch { /* noop */ }
    }
});

// =============================================================================
// Robustez — el pipeline no puede morir
// =============================================================================

test('un descriptor imposible de sellar va a fallido, NUNCA vuelve a pendiente', async () => {
    // Artefacto vacío: `bytes > 0` falla ⇒ fail-closed. Si cayera al catch
    // genérico volvería a pendiente/ y armaría un loop de reintento infinito.
    writeEvidence('qa/evidence/6013/qa-6013-structural.md', '');
    clearTelegramQueue();

    const { listo, fallido, pendiente } = await runJob(
        'qa-6013-structural.json',
        structuralJob(6013, 'qa/evidence/6013/qa-6013-structural.md'),
    );

    assert.equal(listo, null, 'evidencia vacía no es evidencia');
    assert.equal(pendiente, null, 'NUNCA debe volver a pendiente/ (loop infinito)');
    assert.ok(fallido, 'fail-closed a fallido/');
});

test('el containment no explota si un directorio del allowlist no existe', () => {
    // R-2: `realpathSync` del dir base va en try/catch y degrada a "no
    // permitido", nunca a excepción no manejada.
    const inexistente = path.join(SVC_PROJECT, 'docs', 'qa');
    try { fs.rmSync(inexistente, { recursive: true, force: true }); } catch { /* noop */ }
    assert.doesNotThrow(() => drive.isWithinAllowedEvidenceDir(path.join(inexistente, 'x.pdf')));
    assert.equal(drive.isWithinAllowedEvidenceDir(path.join(inexistente, 'x.pdf')), false);
});

test.after(() => {
    try { fs.rmSync(SVC_PROJECT, { recursive: true, force: true }); } catch { /* noop */ }
});
