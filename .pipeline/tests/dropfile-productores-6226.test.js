// =============================================================================
// Tests #6226 (rebote rev-1) — MIGRACIÓN DE LOS PRODUCTORES DE DROPFILES
//
// El fix original de #6226 creó `lib/dropfile-writer.js` y migró
// `pulpo.js::sendTelegramWithMarkup` (el productor donde se reportó el bug),
// pero dejó SIN migrar al resto de los productores. QA lo rechazó: el
// "Cambios requeridos #3" del issue pide explícitamente revisar TODOS los
// puntos que arman el nombre con `Date.now()` solo.
//
// Estos tests cubren los productores que quedaron afuera. Cada uno reproduce
// la pérdida real que QA observó, no una condición sintética:
//
//   - `multi-provider/health-cron.js::defaultTelegramSender` — `emitAlerts()`
//     lo invoca UNA VEZ POR ALERTA dentro del mismo tick. Con 4 providers en
//     rojo se emitían 4 alertas y quedaban 3 archivos: una se perdía en
//     silencio (el sender devolvía `true` igual).
//
//   - `agent-models-change-alert.js::sendAlert` — armaba el nombre con un `now`
//     capturado FUERA del `for (const window of windows)`. Con N ventanas
//     consolidadas el path era EL MISMO para todas, de forma determinista: no
//     dependía de la velocidad del reloj.
//
//   - `cost-anomaly-alert.js::sendTelegramAlert` — mismo patrón de nombre.
//
// REBOTE rev-2 — QA encontró que la migración seguía incompleta y que el guard
// estructural tenía un falso negativo que lo explicaba:
//
//   - `notifier-infra-recovered.js::defaultSendTelegramMessage` — nombraba
//     `notifier-${Date.now()}-${process.pid}.json` (el `pid` es CONSTANTE dentro
//     del proceso: el único desempate era el ms) y escribía con
//     `writeJsonAtomic` (tmp + rename, que sobreescribe sin error). `notify()`
//     llama al sender DOS veces en el mismo tick —mensaje principal + alerta
//     global de rate limit de TTS— así que con el reloj congelado se emitían 2
//     mensajes y quedaba 1 archivo: el PRIMERO se perdía. Mismo síntoma que
//     reportó el operador, misma cola.
//
//   - `notify-telegram.js::notifyTelegram` — ya usaba flag `wx`, así que no
//     sobreescribía, pero SIN reintento: el EEXIST volvía como `write_failed` y
//     el aviso se descartaba igual. CA-3 pide reintentar y dejar registro.
//
//   - El guard no veía la forma `<ts>-<pid>.json` porque su clase de caracteres
//     cortaba ante la segunda interpolación. Ver el comentario de `COLISIONABLE`.
//
// Los guards estructurales corren sobre TODO `.pipeline/`: si alguien suma un
// productor nuevo con nombre colisionable escrito con un writer que pisa, falla
// acá. Los tests de mutación que los acompañan demuestran que el patrón detecta
// lo que antes se le escapaba — un guard que nunca falla es indistinguible de un
// guard que no mira nada, que es exactamente cómo esta clase de bug llegó a
// producción la primera vez.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIPELINE_DIR = path.resolve(__dirname, '..');

const healthCron = require(path.join(PIPELINE_DIR, 'lib', 'multi-provider', 'health-cron.js'));
const modelsAlert = require(path.join(PIPELINE_DIR, 'lib', 'agent-models-change-alert.js'));
const costAlert = require(path.join(PIPELINE_DIR, 'lib', 'cost-anomaly-alert.js'));
const notifier = require(path.join(PIPELINE_DIR, 'notifier-infra-recovered.js'));

// -----------------------------------------------------------------------------
// COLISIONABLE — patrón del guard estructural
// -----------------------------------------------------------------------------
//
// Detecta nombres de dropfile armados con un template literal cuyo ÚNICO
// desempate es el timestamp (la forma canónica del bug de #6226).
//
// #6226 (rebote rev-2) — la versión anterior del patrón era:
//
//     /\$\{\s*(Date\.now\(\)|now|nowMs|ts|stamp)\s*\}-[a-zA-Z0-9._-]*\.(json|txt|md)/
//
// y dejaba pasar `notifier-${Date.now()}-${process.pid}.json` — el productor
// real que QA encontró sin migrar — porque la clase `[a-zA-Z0-9._-]*` CORTA
// ante el `$` de una segunda interpolación: el patrón nunca llegaba a `.json`.
//
// El agujero no era cosmético: `process.pid` es CONSTANTE dentro del proceso,
// así que sumarlo al nombre no aporta desempate alguno — el único que queda
// sigue siendo el milisegundo. Por eso la parte "inerte" del nombre ahora
// admite, además de literales, las interpolaciones de constantes de proceso
// (`process.pid`, `process.ppid`, `pid`, `hostname`): son texto fijo disfrazado
// de variable.
//
// Lo que NO se admite —y por eso corta el match— es cualquier OTRA
// interpolación (`${seq}`, `${rnd}`, `${random}`, `${corrId}`, `${i}`): esas sí
// varían dentro del mismo milisegundo, así que el nombre no es colisionable y
// el productor no es ofensor.
//
// Se conserva el guion obligatorio inmediatamente después del timestamp para no
// marcar a los productores cuyo nombre TERMINA en el timestamp
// (`${issue}-<label>-block-${Date.now()}.json`): ésos ya están migrados a
// `writeUniqueFileSync`, que es fail-closed con reintento.
const TS_TOKEN = String.raw`\$\{\s*(?:Date\.now\(\)|now|nowMs|ts|stamp)\s*\}`;
const PROCESS_CONST = String.raw`\$\{\s*(?:process\.pid|process\.ppid|pid|PID|hostname)\s*\}`;
// Literales del nombre + interpolaciones que no desempatan. Las dos ramas son
// disjuntas en cada posición (la clase de caracteres no matchea `$`), así que
// no hay backtracking exponencial.
const INERTE = `(?:[a-zA-Z0-9._-]|${PROCESS_CONST})*`;
const COLISIONABLE = new RegExp(`${TS_TOKEN}-${INERTE}\\.(?:json|txt|md)`);

// -----------------------------------------------------------------------------
// escritoPorWriterSeguro — el nombre colisionable no es, por sí solo, el defecto
// -----------------------------------------------------------------------------
//
// Lo que hace perder mensajes es la ESCRITURA, no el string. `dropfile-writer`
// tiene dos funciones y sólo una reescribe el nombre:
//
//   - `writeDropfileSync`  → nombre nuevo `<ts>-<seq>-<sufijo>` (desempata solo).
//   - `writeUniqueFileSync` → conserva el nombre pedido TAL CUAL, porque hay
//     colas donde el nombre carga semántica (`alert-svc-telegram…` lo parsea
//     `servicio-telegram.js`, `cross-provider-…` define el orden de drenado), y
//     sólo ante colisión real desambigua con `-<n>` + `onCollision`.
//
// Un nombre `<ts>-<pid>.json` escrito con `writeUniqueFileSync` es fail-closed:
// no pisa ni descarta. Marcarlo como ofensor sería un falso positivo que
// empujaría a renombrar colas cuyo nombre no se puede renombrar.
//
// Heurística: se mira hacia adelante hasta la PRIMERA llamada de escritura. Si
// es un writer seguro, el nombre está cubierto; si es una escritura cruda
// (`writeFileSync`, `renameSync`, `writeJsonAtomic`), es ofensor. Se toma la
// primera y no "cualquiera en la ventana" para no dejar que un writer seguro no
// relacionado, más abajo en el archivo, tape una escritura cruda.
const VENTANA_ESCRITURA = 30;
const WRITER_SEGURO = /\b(?:writeDropfileSync|writeUniqueFileSync)\s*\(/;
const WRITER_CRUDO = /\b(?:writeFileSync|renameSync|appendFileSync|writeJsonAtomic|createWriteStream)\s*\(/;

function escritoPorWriterSeguro(lines, idx) {
    const hasta = Math.min(lines.length, idx + 1 + VENTANA_ESCRITURA);
    for (let j = idx; j < hasta; j++) {
        const l = lines[j];
        const t = l.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        if (WRITER_SEGURO.test(l)) return true;
        if (WRITER_CRUDO.test(l)) return false;
    }
    return false;
}

function tmpRoot(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    fs.mkdirSync(path.join(dir, 'servicios', 'telegram', 'pendiente'), { recursive: true });
    return dir;
}

function rmr(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function queueFiles(root) {
    return fs.readdirSync(path.join(root, 'servicios', 'telegram', 'pendiente')).sort();
}

function readQueued(root, name) {
    return JSON.parse(fs.readFileSync(path.join(root, 'servicios', 'telegram', 'pendiente', name), 'utf8'));
}

// -----------------------------------------------------------------------------
// health-cron — N alertas del mismo tick
// -----------------------------------------------------------------------------

test('health-cron · 4 alertas emitidas en el mismo tick producen 4 dropfiles y ninguna se pierde', () => {
    const root = tmpRoot('mp-health-6226');
    // Congelar el reloj es EXACTAMENTE la condición del bug: `emitAlerts()`
    // encadena los 4 sends sin ceder el event loop, así que caen en el mismo ms.
    const FROZEN = 1787039565917;
    const realNow = Date.now;
    Date.now = () => FROZEN;

    try {
        const providers = ['anthropic', 'openai', 'gemini', 'deepseek'];
        const snapshot = {
            providers: providers.map(p => ({
                provider: p, state: 'red', reason_code: 'auth_error', consecutive_count: 3,
            })),
        };
        const prevSnapshot = { providers: providers.map(p => ({ provider: p, state: 'green' })) };

        const sent = healthCron.emitAlerts({
            snapshot,
            prevSnapshot,
            dedupFile: path.join(root, 'dedup.json'),
            now: FROZEN,
            telegramSender: (payload) => healthCron.defaultTelegramSender(payload, { pipelineDir: root }),
        });

        assert.equal(sent.length, 4, 'las 4 transiciones a rojo deben emitir alerta');

        const files = queueFiles(root);
        assert.equal(files.length, 4, 'debe haber un dropfile por alerta, no menos');
        assert.equal(new Set(files).size, 4, 'los nombres deben ser todos distintos');

        // Ningún provider se perdió: cada alerta tiene su archivo con su texto.
        const provsEnCola = files.map(f => (readQueued(root, f).text.match(/`([a-z0-9-]+)`/) || [])[1]);
        for (const p of providers) {
            assert.ok(provsEnCola.includes(p), `la alerta de \`${p}\` no puede perderse en silencio`);
        }

        // El orden lexicográfico del nombre sigue siendo el orden de emisión:
        // el servicio drena por nombre, así que esto ES el orden de lectura.
        assert.deepEqual(provsEnCola, providers, 'el orden de emisión debe preservarse');
    } finally {
        Date.now = realNow;
        rmr(root);
    }
});

test('health-cron · un dropfile preexistente con el mismo nombre no se sobreescribe', () => {
    const root = tmpRoot('mp-health-clash-6226');
    const FROZEN = 1787039565917;
    const realNow = Date.now;
    Date.now = () => FROZEN;

    try {
        const qDir = path.join(root, 'servicios', 'telegram', 'pendiente');
        // Resto de una corrida anterior que ocupa el primer nombre calculado.
        const ocupado = path.join(qDir, `${FROZEN}-0000-mp-health.json`);
        fs.writeFileSync(ocupado, '{"text":"PREEXISTENTE"}', 'utf8');

        const ok = healthCron.defaultTelegramSender(
            { provider: 'anthropic', state: 'red', reason_code: 'auth_error', observed_at: 'x' },
            { pipelineDir: root },
        );

        assert.equal(ok, true, 'el envío debe reportar éxito');
        assert.equal(
            fs.readFileSync(ocupado, 'utf8'), '{"text":"PREEXISTENTE"}',
            'el archivo preexistente NO se sobreescribe',
        );
        assert.equal(queueFiles(root).length, 2, 'el mensaje nuevo va a un nombre distinto');
    } finally {
        Date.now = realNow;
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// agent-models-change-alert — N ventanas consolidadas
// -----------------------------------------------------------------------------

function makeFakeGit({ commits, blobs }) {
    return function fakeExec(cmd, args) {
        if (cmd !== 'git') throw new Error(`fake git: cmd inesperado ${cmd}`);
        if (args[0] === 'log') {
            return commits.map((c) => {
                const header = `\x1f${c.sha}\x1e${c.ts}\x1e${(c.parents || []).join(' ')}`;
                const files = (c.files || []).join('\n');
                return files ? `${header}\n${files}` : header;
            }).join('\n');
        }
        if (args[0] === 'show') {
            const sha = String(args[1] || '').split(':')[0];
            const blob = blobs[sha];
            if (blob == null) { const e = new Error('no blob'); e.status = 128; throw e; }
            return typeof blob === 'string' ? blob : JSON.stringify(blob);
        }
        if (args[0] === 'rev-parse') return 'HEAD-FAKE\n';
        throw new Error(`fake git: subcmd no soportado ${args[0]}`);
    };
}

function modelsCfg(model) {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model, spawn_args_template: ['-p', '{user_prompt}'] },
        },
        skills: { 'backend-dev': { provider: 'anthropic', model_override: model } },
    };
}

test('agent-models-change-alert · 3 ventanas consolidadas producen 3 dropfiles distintos', () => {
    const root = tmpRoot('models-alert-6226');
    try {
        // Commits separados por 2h > windowMs(5min) => 3 ventanas distintas.
        const commits = [
            { sha: 'c1', ts: '2026-05-08T10:00:00Z', parents: ['p0'], files: ['.pipeline/agent-models.json'] },
            { sha: 'c2', ts: '2026-05-08T12:00:00Z', parents: ['c1'], files: ['.pipeline/agent-models.json'] },
            { sha: 'c3', ts: '2026-05-08T14:00:00Z', parents: ['c2'], files: ['.pipeline/agent-models.json'] },
        ];
        const blobs = {
            p0: modelsCfg('claude-opus-4-7'),
            c1: modelsCfg('claude-sonnet-4-5'),
            c2: modelsCfg('gpt-5-codex'),
            c3: modelsCfg('gemini-2-5-pro'),
        };

        const res = modelsAlert.sendAlert('p0', 'c3', {
            pipelineDir: root,
            cwd: root,
            execFile: makeFakeGit({ commits, blobs }),
            windowMs: 5 * 60 * 1000,
            // Reloj congelado: el bug NO dependía del reloj (el `now` estaba
            // capturado fuera del loop), así que congelarlo no lo enmascara.
            now: () => 1787039565917,
        });

        assert.equal(res.alerts.length, 3, 'una alerta por ventana');

        const files = queueFiles(root);
        assert.equal(files.length, 3, 'una ventana pisaba a la otra: debe haber 3 archivos');
        assert.equal(new Set(files).size, 3, 'los nombres deben ser todos distintos');

        // `queueFile` reportado por sendAlert tiene que coincidir con lo que
        // realmente quedó en disco (antes reportaba 3 paths idénticos).
        const reportados = res.alerts.map(a => path.basename(a.queueFile)).sort();
        assert.deepEqual(reportados, files, 'el queueFile reportado debe ser el archivo real');
    } finally {
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// cost-anomaly-alert
// -----------------------------------------------------------------------------

test('cost-anomaly-alert · dos alertas en el mismo milisegundo no se pisan', () => {
    const root = tmpRoot('cost-anomaly-6226');
    try {
        const FROZEN = 1787039565917;
        const evaluation = {
            anomalous: true, skill: 'backend-dev', level: 'warn',
            observed: 12.5, baseline: 3.1, ratio: 4.03,
        };
        const snapshot = { window: '24h', total_usd: 42.0 };

        const a = costAlert.sendTelegramAlert(evaluation, snapshot, { pipelineDir: root, now: () => FROZEN });
        const b = costAlert.sendTelegramAlert(evaluation, snapshot, { pipelineDir: root, now: () => FROZEN });

        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        assert.notEqual(a.file, b.file, 'los dos paths deben ser distintos');
        assert.equal(queueFiles(root).length, 2, 'ninguna alerta se pierde');
    } finally {
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// Guard estructural — ningún productor nuevo puede volver a colisionar
// -----------------------------------------------------------------------------

test('guard · ningún productor de .pipeline arma el nombre de un dropfile con timestamp solo', () => {
    const SKIP_DIRS = new Set(['node_modules', '__tests__', 'tests', '.git', 'logs', 'servicios']);

    function walk(dir, acc) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), acc);
            } else if (entry.isFile() && entry.name.endsWith('.js')
                       && !entry.name.endsWith('.test.js')
                       // `test-*.js` son harnesses de test que viven fuera de
                       // `tests/` (ej. `test-connectivity-precheck.js`).
                       && !entry.name.startsWith('test-')) {
                acc.push(path.join(dir, entry.name));
            }
        }
        return acc;
    }

    const ofensores = [];
    for (const file of walk(PIPELINE_DIR, [])) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            const trimmed = line.trim();
            // Los comentarios explican el bug viejo citando el patrón: no cuentan.
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            // Scratch files en el tmpdir del SO no son dropfiles de cola.
            if (line.includes('tmpdir()')) return;
            if (!COLISIONABLE.test(line)) return;
            if (escritoPorWriterSeguro(lines, i)) return;
            ofensores.push(`${path.relative(PIPELINE_DIR, file)}:${i + 1}: ${trimmed}`);
        });
    }

    assert.deepEqual(
        ofensores, [],
        'Estos productores arman el nombre del dropfile con un timestamp sin desempate '
        + 'y lo escriben con un writer que puede pisar o descartar contenido (#6226). '
        + 'Usá `lib/dropfile-writer.js`: `writeDropfileSync` (suma un `seq`) o '
        + `\`writeUniqueFileSync\` (conserva el nombre y desambigua ante colisión):\n  `
        + ofensores.join('\n  '),
    );
});

// -----------------------------------------------------------------------------
// Mutación del guard — demuestra que el patrón detecta lo que antes se le
// escapaba, y que NO marca a los productores que sí desempatan.
// -----------------------------------------------------------------------------
//
// Sin este test el guard puede volver a degradarse en silencio: un guard que
// nunca falla es indistinguible de un guard que no mira nada. Acá se le pasan
// líneas sintéticas (control positivo y negativo) en vez de escribir archivos
// ofensores en el árbol real, que es lo que hizo QA a mano en el rebote rev-2.
test('guard · el patrón detecta `${Date.now()}-${process.pid}.json` (mutación rev-2)', () => {
    // Ofensores: el único desempate es el milisegundo.
    const OFENSORES = [
        // El defecto exacto del rebote rev-2 (`notifier-infra-recovered.js:402`).
        'const name = `notifier-${Date.now()}-${process.pid}.json`;',
        // La forma original del issue (ya cubierta por el patrón viejo).
        'const filename = `${Date.now()}-cmd.json`;',
        // Variantes: alias del timestamp + constantes de proceso encadenadas.
        'const f = `alert-${ts}-${pid}.json`;',
        'const f = `snap-${nowMs}-${process.pid}-${hostname}.json`;',
        'const f = `${stamp}-reporte.md`;',
    ];
    for (const linea of OFENSORES) {
        assert.equal(
            COLISIONABLE.test(linea), true,
            `el guard DEBE marcar como colisionable: ${linea}`,
        );
    }

    // No ofensores: hay un desempate real dentro del milisegundo.
    const SANOS = [
        // Lo que produce `dropfile-writer.js::buildDropfileName`.
        'return `${ts}-${padSeq(nextSeqFor(ts))}-${suffix}`;',
        'const f = `${Date.now()}-${seq}-cmd.json`;',
        'const f = `${Date.now()}-${rnd}.json`;',
        'const f = `gate3-${Date.now()}-${pid}-${random}.json`;',
        'const f = `${Date.now()}-voice-${corrId}-p${pi}.json`;',
        // Nombre que TERMINA en el timestamp: fuera del alcance del guard, ya
        // migrado a `writeUniqueFileSync` (fail-closed con reintento).
        'const f = `${issue}-${label}-block-${Date.now()}.json`;',
    ];
    for (const linea of SANOS) {
        assert.equal(
            COLISIONABLE.test(linea), false,
            `el guard NO debe marcar (tiene desempate real): ${linea}`,
        );
    }
});

test('guard · un nombre colisionable escrito con writer crudo es ofensor; con writer seguro no', () => {
    // Ofensor: el nombre no desempata Y la escritura pisa. Es el defecto del
    // rebote rev-2 (`notifier-infra-recovered.js`) reproducido en sintético.
    const crudo = [
        'const name = `notifier-${Date.now()}-${process.pid}.json`;',
        'const filepath = path.join(dropDir, name);',
        'writeJsonAtomic(filepath, { text }, injected);',
    ];
    assert.equal(COLISIONABLE.test(crudo[0]), true);
    assert.equal(escritoPorWriterSeguro(crudo, 0), false, 'writeJsonAtomic pisa: debe ser ofensor');

    // Exento: mismo nombre, pero fail-closed con reintento y log.
    const seguro = [
        'const fname = `cross-provider-${Date.now()}-${process.pid}.json`;',
        'dropfileWriter.writeUniqueFileSync({',
        '    dir: queueDir,',
        '    filename: fname,',
        '});',
    ];
    assert.equal(COLISIONABLE.test(seguro[0]), true);
    assert.equal(escritoPorWriterSeguro(seguro, 0), true, 'writeUniqueFileSync no pisa: exento');

    // La escritura cruda gana si aparece ANTES: un writer seguro no relacionado
    // más abajo no puede tapar una escritura que sí pisa.
    const mixto = [
        'const name = `x-${Date.now()}-${process.pid}.json`;',
        'fs.writeFileSync(path.join(dir, name), payload);',
        'dropfileWriter.writeUniqueFileSync({ dir, filename: otro, data });',
    ];
    assert.equal(escritoPorWriterSeguro(mixto, 0), false, 'la primera escritura manda');

    // Sin ninguna escritura dentro de la ventana no hay evidencia de cobertura:
    // fail-closed, se reporta como ofensor para que alguien lo mire.
    assert.equal(escritoPorWriterSeguro(['const name = `${Date.now()}-cmd.json`;'], 0), false);
});

// -----------------------------------------------------------------------------
// notifier-infra-recovered — el defecto del rebote rev-2
// -----------------------------------------------------------------------------
//
// `notify()` invoca al sender DOS veces en el mismo tick (mensaje principal +
// alerta global de rate limit de TTS). El nombre era
// `notifier-${Date.now()}-${process.pid}.json` —con el `pid` constante dentro
// del proceso, el único desempate era el milisegundo— y se escribía con
// `writeJsonAtomic` (tmp + rename, que SOBREESCRIBE sin error): 2 mensajes
// emitidos, 1 archivo en cola, el PRIMERO perdido en silencio.
test('notifier-infra-recovered · mensaje + alerta global del mismo tick no se pisan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-6226-'));
    const FROZEN = 1787039565917;
    const realNow = Date.now;
    Date.now = () => FROZEN;
    try {
        const dropDir = path.join(root, 'pendiente');
        fs.mkdirSync(dropDir, { recursive: true });
        const rateFile = path.join(root, 'rate.json');
        // Cuota global de TTS agotada → `notify()` emite la alerta global además
        // del mensaje. Es la condición exacta que dispara los dos sends.
        fs.writeFileSync(rateFile, JSON.stringify({
            perIssue: {},
            global: Array.from({ length: 12 }, (_, i) => FROZEN - i * 1000),
            lastGlobalAlertTs: 0,
        }));

        const res = await notifier.notify(
            { requeued: { issues: [6226, 6227] } },
            {
                dropDir,
                dedupFile: path.join(root, 'dedup.json'),
                rateLimitFile: rateFile,
                now: () => FROZEN,
                sendTtsAudio: async () => ({ sent: false }),
            },
        );

        assert.equal(res.globalAlert, true, 'la alerta global debe emitirse');

        const files = fs.readdirSync(dropDir).sort();
        assert.equal(files.length, 2, 'los DOS salientes deben quedar en la cola');
        assert.equal(new Set(files).size, 2, 'los nombres deben ser distintos');

        const textos = files.map(f => JSON.parse(fs.readFileSync(path.join(dropDir, f), 'utf8')).text);
        assert.ok(textos.some(t => t.includes('6226')), 'el mensaje principal no puede perderse');
        assert.ok(textos.some(t => t.includes('audios por hora')), 'la alerta global no puede perderse');

        // Orden de emisión = orden lexicográfico del nombre = orden de lectura.
        assert.ok(textos[0].includes('6226'), 'el mensaje principal se lee primero');

        // Invariante de `telegram-burst-grouper.js::extractPidFromFilename`
        // (`/-(\d+)\.json$/`): el pid sigue derivándose del nombre, así que el
        // agrupamiento de bursts de este productor no cambia.
        for (const f of files) {
            assert.match(f, /-(\d+)\.json$/, `el pid debe seguir al final del nombre: ${f}`);
            assert.equal((f.match(/-(\d+)\.json$/) || [])[1], String(process.pid));
        }
    } finally {
        Date.now = realNow;
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// notify-telegram — fail-closed sin reintento también perdía avisos
// -----------------------------------------------------------------------------
//
// Este productor ya escribía con flag `wx`, así que NO sobreescribía; pero sin
// reintento el EEXIST volvía como `write_failed` y el segundo aviso se
// DESCARTABA. CA-3 pide reintentar con otro nombre y dejar registro.
test('notify-telegram · dos avisos del mismo componente en el mismo ms no se descartan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-tg-6226-'));
    const prevOverride = process.env.PIPELINE_DIR_OVERRIDE;
    const prevChat = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    const FROZEN = 1787039565917;
    const realNow = Date.now;
    Date.now = () => FROZEN;
    try {
        process.env.PIPELINE_DIR_OVERRIDE = dir;
        delete require.cache[require.resolve(path.join(PIPELINE_DIR, 'lib', 'notify-telegram.js'))];
        const mod = require(path.join(PIPELINE_DIR, 'lib', 'notify-telegram.js'));

        const payload = { level: 'error', component: 'svc-telegram', message: 'primer aviso' };
        const a = mod.notifyTelegram(payload);
        const b = mod.notifyTelegram({ ...payload, message: 'segundo aviso' });

        assert.equal(a.ok, true, 'el primer aviso se escribe');
        assert.equal(b.ok, true, 'el segundo NO puede terminar en write_failed');
        assert.notEqual(a.dropPath, b.dropPath, 'deben ser dos archivos distintos');

        const textos = [a, b].map(r => JSON.parse(fs.readFileSync(r.dropPath, 'utf8')).text);
        assert.ok(textos[0].includes('primer aviso'), 'el primero queda intacto');
        assert.ok(textos[1].includes('segundo aviso'), 'el segundo no se pierde');

        // El nombre del camino feliz no cambia: `servicio-telegram.js` parsea el
        // prefijo con `startsWith('alert-svc-telegram')`.
        assert.ok(path.basename(a.dropPath).startsWith('alert-svc-telegram'),
            `el prefijo del nombre debe conservarse: ${path.basename(a.dropPath)}`);
    } finally {
        Date.now = realNow;
        if (prevOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prevOverride;
        if (prevChat === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = prevChat;
        delete require.cache[require.resolve(path.join(PIPELINE_DIR, 'lib', 'notify-telegram.js'))];
        rmr(dir);
    }
});
