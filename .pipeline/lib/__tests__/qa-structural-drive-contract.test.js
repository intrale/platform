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

// SEC-1 (#4514): el allowlist está PARTIDO. `seal` (vía estructural, sólo sella
// y mueve a `listo/`) acepta `.pipeline/assets/docs`; `upload` (termina en un
// link público de Drive) NO. Las columnas del caso son [ruta, seal?, upload?].
test('R-4 · el allowlist acepta los productores reales de la cola, por vía', () => {
    const casos = [
        ['qa/evidence/4899/qa-4899.mp4', true, true],
        ['qa/evidence/qa-2017.mp4', true, true],                  // plano, sin subdir de issue
        ['qa/recordings/qa-1920.mp4', true, true],
        // SEC-2 (#6497, rebote 1): el spool del bot de Telegram sella SI (la
        // via estructural no publica) y publica NO.
        ['.pipeline/logs/media/qa-1881.mp4', true, false],
        ['docs/qa/reporte-1121-carrito-pedidos.pdf', true, true],
        // SEC-1: store de entregables `sensible: true`. Sella sí, publica NO.
        ['.pipeline/assets/docs/4899/qa-verificacion-4899.md', true, false],
        ['.pipeline/desarrollo/verificacion/procesado/5244.qa', false, false],
        // Directorio oculto de estado del agente, fuera de todo dir de
        // evidencia. El guard es puramente posicional -- no mira el nombre del
        // archivo -- así que el fixture es un centinela neutro a propósito: no
        // hace falta (ni conviene) incrustar la ruta de un store real de
        // credenciales en la suite para cubrir exactamente la misma rama.
        ['.claude/state/fixture-fuera-de-alcance.json', false, false],
    ];
    for (const [rel, enSeal, enUpload] of casos) {
        writeEvidence(rel, 'x');
        const abs = path.join(SVC_PROJECT, rel);
        assert.equal(
            drive.isWithinAllowedEvidenceDir(abs, drive.SEAL_ALLOWED_DIRS), enSeal,
            `${rel} debería ${enSeal ? 'entrar' : 'quedar fuera'} del allowlist de SELLADO`,
        );
        assert.equal(
            drive.isWithinAllowedEvidenceDir(abs, drive.UPLOAD_ALLOWED_DIRS), enUpload,
            `${rel} debería ${enUpload ? 'entrar' : 'quedar fuera'} del allowlist de UPLOAD`,
        );
    }
});

test('SEC-1 · el allowlist de upload NO incluye el store de entregables', () => {
    const store = path.resolve(drive.PROJECT_ROOT, '.pipeline', 'assets', 'docs');
    assert.ok(
        drive.SEAL_ALLOWED_DIRS.includes(store),
        'la vía estructural sí debe aceptarlo (R-4: 6/6 jobs reales son structural)',
    );
    assert.ok(
        !drive.UPLOAD_ALLOWED_DIRS.includes(store),
        'la vía de upload publica un link ABIERTO de Drive: el store de '
        + 'entregables sensibles NUNCA puede estar en su allowlist (SEC-1)',
    );
});

test('SEC-1 · los alias exportados apuntan al allowlist restrictivo (fail-closed)', () => {
    assert.equal(drive.ALLOWED_VIDEO_DIRS, drive.ALLOWED_EVIDENCE_DIRS,
        'el nombre viejo debe apuntar a la MISMA lista, no a una copia divergente');
    // Un consumidor viejo que importe cualquiera de los dos nombres hereda el
    // guard FUERTE, nunca el permisivo.
    assert.equal(drive.ALLOWED_EVIDENCE_DIRS, drive.UPLOAD_ALLOWED_DIRS);
    assert.equal(drive.UPLOAD_ALLOWED_DIRS.length, 3);
    assert.equal(drive.SEAL_ALLOWED_DIRS.length, 5);
});

test('SEC-1 · isWithinAllowedEvidenceDir sin allowlist explícito usa el de upload', () => {
    const rel = '.pipeline/assets/docs/7001/qa-verificacion-7001.md';
    writeEvidence(rel, 'x');
    assert.equal(
        drive.isWithinAllowedEvidenceDir(path.join(SVC_PROJECT, rel)), false,
        'el default debe ser el allowlist restrictivo: una llamada sin opciones '
        + 'no puede terminar siendo más permisiva de lo que corresponde',
    );
});

// =============================================================================
// SEC-1 (#4514) — un entregable `sensible: true` NUNCA se encola a Drive público
//
// Regresión cazada en la verificación de #6497: la ampliación de R-4 metió
// `.pipeline/assets/docs` — el store de `writeDeliverable`, donde viven los
// reportes del agente de security — en un allowlist ÚNICO que gobernaba tanto
// la vía estructural (sella, no publica) como la de upload
// (`qa-video-share.js` → `{"type":"anyone","role":"reader"}`, link ABIERTO).
// Un job de upload apuntando a un reporte de seguridad pasaba el containment.
//
// El gate `r.sensible !== true` vivía SÓLO en `deliverable-notify.js`, o sea en
// UN productor — y los descriptores que el agente de QA escribe a mano
// (`roles/qa.md`: `cat > servicios/drive/pendiente/qa-<issue>-video.json`) no
// pasan por ahí. Un gate que sólo existe en un productor no protege al
// consumidor que publica.
// =============================================================================

function writeDeliverableIndex(issue, entries) {
    const abs = path.join(SVC_PROJECT, '.pipeline', 'deliverables', `${issue}.json`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ issue, entries }, null, 2));
    return abs;
}

// Reporte de security real del store, declarado `sensible: true` en el índice.
const SENSIBLE_REL = '.pipeline/assets/docs/4513/security-verificacion-4513.md';

function seedSensibleDeliverable() {
    writeEvidence(SENSIBLE_REL, '# hallazgos de seguridad\ncredencial expuesta en X\n');
    writeDeliverableIndex(4513, [
        {
            issue: 4513,
            fase: 'verificacion',
            agente: 'security',
            tipo: 'document',
            path: SENSIBLE_REL,
            sensible: true,
        },
    ]);
}

test('SEC-1 · un job de UPLOAD que apunta a un entregable sensible va a FALLIDO', async () => {
    seedSensibleDeliverable();
    clearTelegramQueue();
    // `mode: android` + `source: qa-android` NO matchea el discriminador
    // estructural, o sea que este job sigue por la vía que PUBLICA.
    const job = {
        action: 'upload',
        file: SENSIBLE_REL,
        issue: 4513,
        mode: 'android',
        source: 'qa-android',
    };
    assert.equal(drive.isStructuralEvidenceJob(job), false,
        'el fixture debe ir por la vía de upload, si no el test no prueba nada');

    const r = await runJob('qa-4513-video.json', job);

    assert.ok(r.fallido, 'el job debe terminar en fallido/');
    assert.equal(r.listo, null, 'NUNCA puede llegar a listo/ (de ahí sale el upload)');
    assert.equal(r.pendiente, null, 'no puede volver a pendiente/ y reintentar en loop');
});

test('SEC-1 · el rechazo por sensible NO emite el sha256 (CA-5 / R-7)', async () => {
    seedSensibleDeliverable();
    clearTelegramQueue();
    await runJob('qa-4513-video.json', {
        action: 'upload',
        file: SENSIBLE_REL,
        issue: 4513,
        mode: 'android',
        source: 'qa-android',
    });

    const r = await runJob('qa-4513-bis.json', {
        action: 'upload', file: SENSIBLE_REL, issue: 4513, mode: 'android', source: 'qa-android',
    });
    // El descriptor que quedó en fallido/ no puede llevar el sello: hashear algo
    // que no pasó el guard convierte el rechazo en un oráculo de contenido.
    assert.equal(r.fallido.sha256, undefined, 'el descriptor rechazado no lleva sha256');
    assert.equal(r.fallido.bytes, undefined, 'el descriptor rechazado no lleva bytes');

    const msgs = telegramMessages().join('\n');
    assert.ok(!/sha256/i.test(msgs), 'el aviso no puede contener el hash');
    assert.ok(!/[0-9a-f]{64}/.test(msgs), 'el aviso no puede contener un digest hex');
});

// =============================================================================
// SEC-1 / R-4 (#6497, rebote 2) — EL GATE DE `sensible` ES DE LA VÍA QUE PUBLICA
//
// La primera versión corría `isSensitiveDeliverable()` en AMBAS vías. Medido
// contra la cola y el índice de PRODUCCIÓN, eso mandaba a `fallido/` el 100% de
// los jobs estructurales bajo `.pipeline/assets/docs` (4 de 4 que existen en
// disco), que es exactamente el conjunto que R-4 obligaba a preservar:
//
//   qa-4899-structural.json / qa-4899-structural-rev2.json / qa-5461 / qa-5924
//     → todos `.pipeline/assets/docs/<issue>/qa-verificacion-<issue>.md`
//
// y no era un borde: de las 145 entradas `qa-verificacion-<issue>.md` del índice,
// las 145 están en `sensible: true` y NINGUNA en `false` (475 `sensible: true`
// en total, el 100% bajo ese store). O sea `.pipeline/assets/docs` en
// `SEAL_ALLOWED_DIRS` era configuración muerta, y encima el aviso decía "fallo
// al subir" sobre una vía que no sube nada.
//
// Estos tests fijan la decisión (a) de la remediación: el gate queda SÓLO en la
// vía de upload — la que produce el link `{"type":"anyone","role":"reader"}` —
// y la estructural sella. Los fixtures usan el flag REAL del índice
// (`sensible: true`), no uno fabricado que no existe en producción.
// =============================================================================

// Ruta y flag exactamente como aparecen en el índice de producción.
const QA_VERIF_REL = '.pipeline/assets/docs/4899/qa-verificacion-4899.md';

function seedQaVerificacionDeliverable() {
    writeEvidence(QA_VERIF_REL, '# verificacion de QA\n');
    writeDeliverableIndex(4899, [
        {
            issue: 4899,
            fase: 'verificacion',
            agente: 'qa',
            tipo: 'document',
            path: QA_VERIF_REL,
            sensible: true,
        },
    ]);
}

test('SEC-1/R-4 · el caso REAL de producción (qa-verificacion sensible:true) SE SELLA', async () => {
    // Este es el job que hoy vive en la cola: `mode: structural` +
    // `source: qa-structural`, `file` bajo `.pipeline/assets/docs`, entrada de
    // índice `sensible: true`. Si este test se cae, R-4 volvió a estar roto.
    seedQaVerificacionDeliverable();
    assert.equal(drive.isSensitiveDeliverable(QA_VERIF_REL, 4899), true,
        'el fixture debe reflejar el índice real: qa-verificacion está en sensible: true');

    const r = await runJob('qa-4899-structural.json', structuralJob(4899, QA_VERIF_REL));

    assert.ok(r.listo, 'la vía estructural debe sellar y llegar a listo/ (R-4)');
    assert.equal(r.fallido, null, 'sellar no es publicar: no puede ir a fallido/');
    assert.match(r.listo.sha256, drive.SHA256_RE);
    assert.ok(r.listo.bytes > 0);
});

test('SEC-1/R-4 · el MISMO artefacto sensible por la vía de UPLOAD sigue vetado', async () => {
    // La contracara: lo que protege a este artefacto es el allowlist partido
    // (capa 1) más el gate de índice (capa 2), ambos en la vía que publica.
    seedQaVerificacionDeliverable();
    clearTelegramQueue();
    const job = {
        action: 'upload',
        file: QA_VERIF_REL,
        issue: 4899,
        mode: 'android',
        source: 'qa-android',
    };
    assert.equal(drive.isStructuralEvidenceJob(job), false,
        'el fixture debe ir por la vía de upload, si no el test no prueba nada');

    const r = await runJob('qa-4899-upload.json', job);

    assert.ok(r.fallido, 'un job de upload sobre el store de entregables va a fallido/');
    assert.equal(r.listo, null, 'NUNCA puede llegar a listo/ (de ahí sale el upload)');
    assert.equal(r.fallido.sha256, undefined, 'el descriptor rechazado no lleva sha256');
});

test('SEC-1/R-4 · el reporte de security sensible también se sella por la vía estructural', async () => {
    // Mismo criterio para el otro poblador del store (329 entradas del agente de
    // security): sellar no publica. `listo/` es estado TERMINAL — nadie lo
    // consume para subir; el upload ocurre dentro de `processJob`, antes.
    seedSensibleDeliverable();
    const r = await runJob('qa-4513-structural.json', structuralJob(4513, SENSIBLE_REL));
    assert.ok(r.listo, 'la vía que sólo sella no aplica el gate de publicación');
    assert.match(r.listo.sha256, drive.SHA256_RE);
    assert.equal(r.fallido, null);
});

test('SEC-1 · resolveConfinedEvidence sin `publishes` explícito SÍ chequea sensible (fail-closed)', () => {
    // El default no puede ser el permisivo: un llamador nuevo que se olvide de
    // declarar la vía tiene que heredar el guard fuerte, no saltearlo.
    seedSensibleDeliverable();
    const strict = drive.resolveConfinedEvidence(SENSIBLE_REL, {
        dirs: drive.SEAL_ALLOWED_DIRS,
        issue: 4513,
    });
    assert.equal(strict.ok, false, 'sin `publishes` el gate de publicación debe correr');
    assert.equal(strict.reason, drive.REJECT_SENSIBLE_NO_PUBLICABLE);

    const seal = drive.resolveConfinedEvidence(SENSIBLE_REL, {
        dirs: drive.SEAL_ALLOWED_DIRS,
        publishes: false,
        issue: 4513,
    });
    assert.equal(seal.ok, true, 'con `publishes: false` (vía que sella) debe pasar');
});

test('SEC-1 · el gate detecta el sensible aunque el job declare OTRO issue', async () => {
    // El campo `issue` lo controla el agente que escribe el descriptor a mano:
    // declarar un issue distinto no puede servir para esquivar el índice. El
    // gate también deriva el issue de la propia ruta canónica.
    seedSensibleDeliverable();
    assert.equal(drive.isSensitiveDeliverable(SENSIBLE_REL, 9999), true,
        'debe encontrar el índice por el issue de la ruta, no sólo por el declarado');
    assert.equal(drive.isSensitiveDeliverable(SENSIBLE_REL, undefined), true);
});

test('SEC-1 · el modo log-only NO relaja el rechazo por entregable sensible', async (t) => {
    seedSensibleDeliverable();
    clearTelegramQueue();
    // El rollout observable de R-6 existe para medir el impacto del containment
    // NUEVO sobre la cola real. Un modo de observación jamás puede reabrir el
    // agujero que este commit cierra.
    //
    // Rebote 2: el job del fixture va por la vía de UPLOAD (`mode: android`), que
    // es donde vive el gate de publicación. La rama log-only sólo exime a la vía
    // estructural, así que este job tiene que ir a FALLIDO igual.
    const previo = process.env.DRIVE_CONTAINMENT_MODE;
    process.env.DRIVE_CONTAINMENT_MODE = 'log-only';
    t.after(() => {
        if (previo === undefined) delete process.env.DRIVE_CONTAINMENT_MODE;
        else process.env.DRIVE_CONTAINMENT_MODE = previo;
    });
    // CONTAINMENT_MODE se lee al requerirse el módulo, así que se recarga.
    delete require.cache[require.resolve('../../servicio-drive')];
    const fresh = require('../../servicio-drive');

    const name = 'qa-4513-logonly.json';
    const uploadJob = {
        action: 'upload',
        file: SENSIBLE_REL,
        issue: 4513,
        mode: 'android',
        source: 'qa-android',
    };
    assert.equal(fresh.isStructuralEvidenceJob(uploadJob), false,
        'el fixture debe ir por la vía que publica, si no el test no prueba nada');
    fs.writeFileSync(path.join(PENDIENTE, name), JSON.stringify(uploadJob));
    await fresh.processJob({ name, path: path.join(PENDIENTE, name) });

    assert.ok(fs.existsSync(path.join(FALLIDO, name)),
        'ni en log-only puede pasar un entregable sensible');
    assert.equal(fs.existsSync(path.join(LISTO, name)), false);

    delete require.cache[require.resolve('../../servicio-drive')];
    require('../../servicio-drive');
});

test('SEC-1 · sin índice de entregables el gate no bloquea (fail-open deliberado)', () => {
    // La inmensa mayoría de los artefactos legítimos (`qa/evidence/**`) no tiene
    // entrada en el índice. "Sin índice ⇒ bloqueado" mandaría la cola entera a
    // FALLIDO. Quien decide qué directorio puede publicarse es el allowlist
    // partido (capa 1); esta capa sólo agrega un veto explícito.
    assert.equal(drive.isSensitiveDeliverable('qa/evidence/6497/qa-6497.mp4', 6497), false);
    assert.equal(drive.isSensitiveDeliverable('', 4513), false);
    assert.equal(drive.isSensitiveDeliverable(null, null), false);
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

// =============================================================================
// SEC-2 (#6497, rebote 1) — el spool del bot de Telegram NO es publicable
//
// Regresión que introdujo el primer intento de R-4: `.pipeline/logs/media`
// entró al allowlist de UPLOAD, la vía que termina en un link
// `{"type":"anyone","role":"reader"}`. Ese directorio es el spool del bot:
// medido, 287 de 307 archivos son `.ogg` de narración de voz al operador.
// =============================================================================

const SPOOL_REL = '.pipeline/logs/media';

test('SEC-2 · el allowlist de upload NO incluye el spool de media del bot', () => {
    const spool = path.resolve(drive.PROJECT_ROOT, '.pipeline', 'logs', 'media');
    assert.ok(
        drive.SEAL_ALLOWED_DIRS.includes(spool),
        'la vía estructural sí lo acepta: sella y mueve a listo/, no publica',
    );
    assert.ok(
        !drive.UPLOAD_ALLOWED_DIRS.includes(spool),
        'la vía de upload publica un link ABIERTO de Drive: el spool del bot de '
        + 'Telegram (~95% narración de voz privada del operador) NUNCA puede '
        + 'estar en su allowlist (SEC-2)',
    );
});

test('SEC-2 · PoC del rechazo: ningún artefacto del spool pasa la vía de upload tal cual', () => {
    const casos = [
        '1787139634397-qO_M9j0E.ogg',   // narración de voz AL operador
        '1787142555894-knO-JT0E.ogg',
        'img-1787320124021.jpg',        // media ENTRANTE del operador
        'qa-4806-screenshot-final.png', // hasta el propio derivado de QA
        'qa-1881.mp4',
    ];
    for (const base of casos) {
        const rel = `${SPOOL_REL}/${base}`;
        writeEvidence(rel, 'x');
        assert.equal(
            drive.isWithinAllowedEvidenceDir(path.join(SVC_PROJECT, rel), drive.UPLOAD_ALLOWED_DIRS),
            false,
            `${rel} no puede entrar por el allowlist de upload`,
        );
        assert.equal(
            drive.resolveConfinedEvidence(rel, { dirs: drive.UPLOAD_ALLOWED_DIRS }).ok,
            false,
            `${rel} no puede pasar el containment de la vía que publica`,
        );
    }
});

test('SEC-2 · el gate de promoción sólo deja pasar el derivado de QA del issue', () => {
    const permitidos = [
        ['qa-7101.mp4', 7101],
        ['qa-7101-rebote.mp4', 7101],
        ['qa-7101-screenshot-final.png', 7101],
        ['qa-7101-test-results.xml', 7101],
    ];
    for (const [base, issue] of permitidos) {
        writeEvidence(`${SPOOL_REL}/${base}`, 'x');
        assert.ok(
            drive.spoolPromotionCandidate(`${SPOOL_REL}/${base}`, issue),
            `${base} es un derivado legítimo de QA del #${issue} y debe promoverse`,
        );
    }

    const vetados = [
        // El corazón del hallazgo: audio del operador, con CUALQUIER issue.
        ['1787139634397-qO_M9j0E.ogg', 7101],
        // …y con el timestamp declarado como issue, que es el bypass obvio del
        // binding por número.
        ['1787139634397-qO_M9j0E.ogg', 1787139634397],
        ['qa-7101.ogg', 7101],          // se llama qa- pero es audio
        ['qa-7101.mp3', 7101],
        ['img-1787320124021.jpg', 7101],
        ['qa-71011.mp4', 7101],         // borde numérico: es de OTRO issue
        ['qa-7102.mp4', 7101],          // issue ajeno
        ['inventado.mp4', 7101],
    ];
    for (const [base, issue] of vetados) {
        writeEvidence(`${SPOOL_REL}/${base}`, 'x');
        assert.equal(
            drive.spoolPromotionCandidate(`${SPOOL_REL}/${base}`, issue),
            null,
            `${base} (issue ${issue}) NO puede promoverse desde el spool`,
        );
    }

    // Nada del spool alcanza la vía de upload por sí solo, ni siquiera lo
    // promovible: la promoción es la ÚNICA puerta y siempre copia antes.
    assert.equal(drive.spoolPromotionCandidate(`${SPOOL_REL}/subdir/qa-7101.mp4`, 7101), null,
        'sin profundidad libre: un nivel dentro del spool y nada más');
    assert.equal(drive.spoolPromotionCandidate('qa/evidence/7101/qa-7101.mp4', 7101), null,
        'lo que ya está en el recinto canónico no se promueve');
});

test('SEC-2 · R-4 sigue vivo: el derivado de QA se promueve, se sella y conserva la ruta declarada', () => {
    const bytes = Buffer.from('video-derivado-de-qa');
    writeEvidence(`${SPOOL_REL}/qa-7202.mp4`, bytes);

    // Forma REAL del job de la cola: `mode: structural` SIN `source` -> no
    // matchea el discriminador y cae en la via de UPLOAD. Es exactamente el
    // caso que motivo la ampliacion de R-4.
    const data = {
        action: 'upload',
        file: `${SPOOL_REL}/qa-7202.mp4`,
        issue: 7202,
        folder: 'QA/evidence/7202',
        description: 'QA video con relato narrado #7202',
        mode: 'structural',
    };
    assert.equal(drive.isStructuralEvidenceJob(data), false,
        'sin `source: qa-structural` el job va por la via que publica');

    // 1. sin promocion, el spool ya no alcanza la via de upload.
    assert.equal(
        drive.resolveConfinedEvidence(data.file, { dirs: drive.UPLOAD_ALLOWED_DIRS, issue: 7202 }).ok,
        false,
        'el spool salio del allowlist de upload (SEC-2)',
    );

    // 2. con la promocion que corre en processJob, el derivado llega igual.
    const promovido = drive.promoteSpoolEvidence(data.file, 7202);
    assert.equal(promovido, 'qa/evidence/7202/qa-7202.mp4',
        'CA-3: el derivado se promueve al recinto canonico');
    assert.ok(
        fs.existsSync(path.join(SVC_PROJECT, 'qa', 'evidence', '7202', 'qa-7202.mp4')),
        'la copia canonica tiene que existir en el repo',
    );

    const confined = drive.resolveConfinedEvidence(promovido, {
        dirs: drive.UPLOAD_ALLOWED_DIRS,
        issue: 7202,
    });
    assert.equal(confined.ok, true, 'R-4 no se rompe: el derivado legitimo sigue publicandose');

    // 3. el sello se deriva sobre la copia canonica, no sobre el spool.
    drive.sealJob(data, confined);
    assert.equal(data.file, 'qa/evidence/7202/qa-7202.mp4');
    assert.equal(data.file_declarado, `${SPOOL_REL}/qa-7202.mp4`,
        'la ruta declarada queda para trazabilidad');
    assert.equal(data.sha256, sha256Of(bytes));
    assert.equal(data.bytes, bytes.length);

    // 4. idempotente: re-promover no rompe ni cambia la ruta canonica.
    assert.equal(drive.promoteSpoolEvidence(`${SPOOL_REL}/qa-7202.mp4`, 7202), promovido);
});

test('SEC-2 · un job que apunta al audio del operador va a FALLIDO sin sello', async () => {
    writeEvidence(`${SPOOL_REL}/1787139634397-qO_M9j0E.ogg`, 'audio-privado-del-operador');
    const { listo, fallido } = await runJob('qa-7303-video.json', {
        action: 'upload',
        file: `${SPOOL_REL}/1787139634397-qO_M9j0E.ogg`,
        issue: 7303,
        folder: 'QA/evidence/7303',
        description: 'payload malicioso #7303',
    });

    assert.equal(listo, null, 'la narración de voz del operador NO puede publicarse');
    assert.ok(fallido, 'tiene que ir a fallido/');
    assert.equal(fallido.sha256, undefined,
        'CA-5 / R-7: lo que no pasa el guard NUNCA obtiene hash');
    assert.ok(
        !fs.existsSync(path.join(SVC_PROJECT, 'qa', 'evidence', '7303', '1787139634397-qO_M9j0E.ogg')),
        'y tampoco puede quedar promovido al recinto de evidencia',
    );
});

test.after(() => {
    try { fs.rmSync(SVC_PROJECT, { recursive: true, force: true }); } catch { /* noop */ }
});

// #6145 — el rechazo de aprobación se produjo porque el rol instruía escribir el
// descriptor con un path RELATIVO: el agente corre con CWD = worktree, así que
// el JSON caía en una cola que el servicio Drive nunca lee. El contrato ahora
// obliga a pasar por el encolador, que ancla el destino en PIPELINE_REPO_ROOT.
test('el rol manda encolar por el CLI anclado y no por escritura directa relativa', () => {
  assert.match(qaRole, /scripts\/qa-evidence-enqueue\.js/);
  assert.match(qaRole, /PIPELINE_REPO_ROOT/);

  // Ninguna instrucción puede volver a redirigir un descriptor a un path
  // relativo: eso es exactamente lo que lo vara en el worktree.
  const redireccionRelativa = />\s*\.pipeline\/servicios\/drive\/pendiente\//;
  assert.doesNotMatch(
    qaRole,
    redireccionRelativa,
    'el rol no debe instruir escribir el descriptor a un path relativo',
  );
});

test('el rol exige verdict, passed, total y head en el descriptor', () => {
  for (const campo of ['verdict', 'passed', 'total', 'head']) {
    assert.match(
      qaRole,
      new RegExp(`--${campo}\\b|\`${campo}\``),
      `el rol debe exigir el campo ${campo} en el descriptor`,
    );
  }
});

test('el CLI y el modulo de encolado existen y exponen el contrato que el rol promete', () => {
  const cli = path.resolve(__dirname, '..', '..', 'scripts', 'qa-evidence-enqueue.js');
  assert.ok(fs.existsSync(cli), `falta el CLI ${cli} que el rol qa.md manda ejecutar`);

  const lib = require('../qa-evidence-enqueue');
  assert.equal(typeof lib.enqueueStructuralEvidence, 'function');
  assert.equal(typeof lib.rescueStrandedDescriptors, 'function');
  assert.equal(lib.REQUIRED_MODE, 'structural');
  assert.equal(lib.REQUIRED_SOURCE, 'qa-structural');
});
