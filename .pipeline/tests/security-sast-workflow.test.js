// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'security-sast.yml'), 'utf8');
const gradleBuild = fs.readFileSync(path.join(repoRoot, 'build.gradle.kts'), 'utf8');

test('conecta al plugin sólo una NVD_API_KEY no blanca', () => {
  assert.match(gradleBuild, /System\.getenv\("NVD_API_KEY"\)[\s\S]*?takeIf \{ it\.isNotBlank\(\) \}[\s\S]*?apiKey = it/);
});

test('renueva la cache NVD v2 sin restaurar la cache v1', () => {
  assert.match(workflow, /key: nvd-data-v2-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /restore-keys:\s*\|\s*nvd-data-v2-/);
  assert.doesNotMatch(workflow, /restore-keys:\s*\|\s*nvd-data-\s*$/m);
  assert.doesNotMatch(workflow, /nvd-data-v1/);
});

test('publica el outcome real y distingue fallo de reporte ausente', () => {
  assert.match(workflow, /scan_outcome: \$\{\{ steps\.owasp-scan\.outcome \}\}/);
  assert.match(workflow, /report_status: \$\{\{ steps\.owasp-report\.outputs\.status \}\}/);
  assert.match(workflow, /find build\/reports -type f -size \+0c/);
  assert.match(workflow, /depCheckOutcome !== 'success'[\s\S]*?'scan fallido'/);
  assert.match(workflow, /depCheckReportStatus !== 'present'[\s\S]*?'reporte ausente'/);
  assert.match(workflow, /: 'scan válido'/);
});

test('advierte la ausencia del secret sin escribir su valor en el summary', () => {
  assert.match(workflow, /API key del NVD no disponible/);
  const summaryWrites = workflow.split('\n').filter((line) => line.includes('GITHUB_STEP_SUMMARY'));
  assert.ok(summaryWrites.length > 0);
  assert.ok(summaryWrites.every((line) => !line.includes('$NVD_API_KEY') && !line.includes('${{ secrets.NVD_API_KEY }}')));
});

// ── Aserciones estructurales (CA-10 / CA-11) ──────────────────────────────────
// Se parsea el YAML y se asevera sobre el árbol: un assert.match sobre el texto
// crudo no distingue el scope de un `env:` y fue exactamente lo que dejó pasar el
// defecto de la condición de credencial (el `env:` de un step no está disponible
// para el `if:` de ese mismo step).
const yaml = require('js-yaml');

const parsedWorkflow = yaml.load(workflow);
const dependencyCheckJob = parsedWorkflow.jobs['dependency-check'];
const dependencyCheckSteps = dependencyCheckJob.steps;
const stepIndexByName = (fragment) =>
  dependencyCheckSteps.findIndex((step) => typeof step.name === 'string' && step.name.includes(fragment));

test('NVD_API_KEY se define a nivel job, no en el env del step que la evalúa', () => {
  assert.equal(dependencyCheckJob.env.NVD_API_KEY, '${{ secrets.NVD_API_KEY }}');

  const stepsQueLaRedefinen = dependencyCheckSteps
    .filter((step) => step.env && Object.prototype.hasOwnProperty.call(step.env, 'NVD_API_KEY'))
    .map((step) => step.name);
  assert.deepEqual(stepsQueLaRedefinen, []);
});

test('la advertencia se condiciona a la presencia real de la key', () => {
  const advertencia = dependencyCheckSteps[stepIndexByName('Advertir ejecución sin NVD API key')];
  assert.ok(advertencia, 'falta el step de advertencia de credencial ausente');
  assert.match(advertencia.if, /env\.NVD_API_KEY\s*==\s*''/);

  const confirmacion = dependencyCheckSteps[stepIndexByName('Confirmar NVD API key disponible')];
  assert.ok(confirmacion, 'falta el step que declara la rama de credencial disponible');
  assert.match(confirmacion.if, /env\.NVD_API_KEY\s*!=\s*''/);
});

test('el encabezado del summary es incondicional y precede a la advertencia', () => {
  const encabezadoIdx = stepIndexByName('Encabezado del summary OWASP');
  const advertenciaIdx = stepIndexByName('Advertir ejecución sin NVD API key');
  assert.ok(encabezadoIdx >= 0, 'falta el step de encabezado del summary');

  const encabezado = dependencyCheckSteps[encabezadoIdx];
  assert.equal(encabezado.if, undefined);
  assert.match(encabezado.run, /## OWASP Dependency Check/);
  assert.ok(encabezadoIdx < advertenciaIdx);

  const advertencia = dependencyCheckSteps[advertenciaIdx];
  assert.doesNotMatch(advertencia.run, /## OWASP Dependency Check/);
});

test('el job no observa ni filtra el valor del secret pese al env de nivel job', () => {
  const runs = dependencyCheckSteps
    .filter((step) => typeof step.run === 'string')
    .map((step) => ({ name: step.name, run: step.run }));
  assert.ok(runs.length > 0);

  for (const { name, run } of runs) {
    assert.doesNotMatch(run, /\$\{\{\s*secrets\./, `${name} interpola el contexto secrets en su run`);
    assert.doesNotMatch(run, /NVD_API_KEY/, `${name} observa la credencial dentro de su run`);
    assert.doesNotMatch(run, /\bprintenv\b/, `${name} vuelca el ambiente completo`);
    assert.doesNotMatch(run, /\bset\s+-[a-z]*x/, `${name} habilita traza de comandos`);
  }

  const envsDelJob = [dependencyCheckJob.env, ...dependencyCheckSteps.map((step) => step.env)].filter(Boolean);
  for (const env of envsDelJob) {
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'ACTIONS_STEP_DEBUG'));
  }
  assert.deepEqual(Object.keys(dependencyCheckJob.env), ['NVD_API_KEY']);
});

// ── Aserciones estructurales (CA-13 / CA-14) ──────────────────────────────────
// CA-8 exige que las dos ramas de credencial EXISTAN; CA-13 exige que sean
// mutuamente excluyentes (nunca las dos juntas, nunca ninguna). CA-14 exige que
// toda línea de estado sea autoexplicativa en texto plano: el summary también se
// lee en logs y notificaciones, donde color, ícono y emoji se pierden.
const lineasDeSummary = (run) =>
  String(run)
    .split('\n')
    .filter((linea) => linea.includes('GITHUB_STEP_SUMMARY'))
    .map((linea) => {
      const entrecomillado = linea.match(/echo\s+"([^"]*)"/);
      return entrecomillado ? entrecomillado[1] : linea.trim();
    });

const PREFIJO_DE_ESTADO = /^Estado (?:de|del) [A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+: \S/;

test('las dos ramas de credencial son mutuamente excluyentes', () => {
  const advertencia = dependencyCheckSteps[stepIndexByName('Advertir ejecución sin NVD API key')];
  const confirmacion = dependencyCheckSteps[stepIndexByName('Confirmar NVD API key disponible')];
  assert.ok(advertencia && confirmacion, 'faltan los steps de las dos ramas de credencial');

  const operadorDe = (step) => {
    const comparacion = String(step.if).match(/env\.NVD_API_KEY\s*(==|!=)\s*''/);
    assert.ok(comparacion, `${step.name} no compara env.NVD_API_KEY contra vacío`);
    return comparacion[1];
  };

  // Misma expresión, operadores opuestos: la disyunción cubre todo el dominio y
  // la conjunción es vacía. Sin esto el summary puede quedar mudo o contradecirse.
  assert.deepEqual([operadorDe(advertencia), operadorDe(confirmacion)].sort(), ['!=', '==']);
});

test('cada rama declara su estado con el prefijo "Estado de…" y sin íconos', () => {
  for (const nombre of ['Advertir ejecución sin NVD API key', 'Confirmar NVD API key disponible']) {
    const step = dependencyCheckSteps[stepIndexByName(nombre)];
    const declaraciones = lineasDeSummary(step.run).filter((linea) => PREFIJO_DE_ESTADO.test(linea));
    assert.equal(declaraciones.length, 1, `${nombre} debe declarar exactamente una línea de estado`);
    assert.match(declaraciones[0], /^Estado de credencial: /);
  }

  // El step de reporte declara estado en sus dos ramas (presente / ausente) más
  // la del scan fallido: tres líneas con el mismo vocabulario.
  const reporte = dependencyCheckSteps[stepIndexByName('Validar reporte OWASP')];
  const estadosDelReporte = lineasDeSummary(reporte.run).filter((linea) => PREFIJO_DE_ESTADO.test(linea));
  assert.equal(estadosDelReporte.length, 3);

  const todasLasLineas = dependencyCheckSteps
    .filter((step) => typeof step.run === 'string')
    .flatMap((step) => lineasDeSummary(step.run));
  assert.ok(todasLasLineas.length > 0);
  for (const linea of todasLasLineas) {
    assert.doesNotMatch(
      linea,
      /[\u2190-\u2BFF\u2600-\u27BF\uFE0F\u{1F000}-\u{1FAFF}]/u,
      `la línea del summary depende de un símbolo no textual: ${linea}`,
    );
  }
});

// ── #7659 — Security SAST fuera del camino de cada PR ─────────────────────────
// Decisión de #7658 (filas 1, 3, 4 y 7): OWASP diario + por PR sólo si el PR toca
// dependencias (opción b); Semgrep y detect-secrets diarios; sin comentario en PR.
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const jobs = parsedWorkflow.jobs;
const triggers = parsedWorkflow.on;
const HEAVY_SCHEDULE_ONLY = ['semgrep', 'detect-secrets'];
const HEAVY = ['dependency-check', ...HEAVY_SCHEDULE_ONLY];

test('#7659 el workflow agrega schedule diario y workflow_dispatch sin inputs interpolados', () => {
  assert.ok(Array.isArray(triggers.schedule) && triggers.schedule.length >= 1, 'falta schedule');
  // Al menos diario (RS-6): minuto y hora fijos, resto comodín.
  assert.match(triggers.schedule[0].cron, /^\d+ \d+ \* \* \*$/);
  assert.ok(Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch'), 'falta workflow_dispatch');
  assert.doesNotMatch(workflow, /\$\{\{\s*inputs\./, 'ningún run puede interpolar inputs');
  // pull_request sin filtro de paths: si no, los PR sin dependencias pierden el Secret scan.
  assert.deepEqual(triggers.pull_request, { branches: ['main', 'develop'] });
  assert.deepEqual(triggers.push, { branches: ['main'] });
});

test('#7659 semgrep y detect-secrets corren sólo en schedule y workflow_dispatch', () => {
  for (const name of HEAVY_SCHEDULE_ONLY) {
    const cond = String(jobs[name].if);
    assert.match(cond, /github\.event_name == 'schedule'/, `${name} sin schedule`);
    assert.match(cond, /github\.event_name == 'workflow_dispatch'/, `${name} sin workflow_dispatch`);
    assert.doesNotMatch(cond, /pull_request/, `${name} no puede correr en PR`);
    assert.doesNotMatch(cond, /push/, `${name} no puede correr en push`);
  }
});

test('#7659 dependency-check corre en schedule, dispatch y en PR sólo si detect-deps dice deps=true', () => {
  const job = jobs['dependency-check'];
  const cond = String(job.if).replace(/\s+/g, ' ');
  assert.equal(job.needs, 'detect-deps');
  // Sin función de estado, el skip de detect-deps en schedule saltearía OWASP.
  assert.match(cond, /^!cancelled\(\) && \(/);
  assert.match(cond, /github\.event_name == 'schedule'/);
  assert.match(cond, /github\.event_name == 'workflow_dispatch'/);
  assert.match(cond, /\(github\.event_name == 'pull_request' && needs\.detect-deps\.outputs\.deps == 'true'\)/);
  assert.equal(job.name, 'OWASP Dependency Check');
});

test('#7659 detect-deps es liviano, sólo en PR, sin concurrency y con actions pineadas', () => {
  const job = jobs['detect-deps'];
  assert.equal(job.if, "github.event_name == 'pull_request'");
  assert.equal(job.concurrency, undefined);
  assert.deepEqual(job.permissions, { contents: 'read' });
  for (const step of job.steps.filter((s) => s.uses)) {
    assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} no está pineada por SHA`);
  }
  const filter = job.steps.find((s) => s.id === 'filter');
  assert.doesNotMatch(filter.run, /\$\{\{/, 'el run no interpola expresiones');
  assert.equal(job.outputs.deps, '${{ steps.filter.outputs.deps }}');
});

test('#7659 el patrón de dependencias distingue un PR de dependencias de uno que no lo es', () => {
  const step = jobs['detect-deps'].steps.find((s) => s.id === 'filter');
  const pattern = new RegExp(step.env.DEPS_PATTERN);
  const tocan = ['gradle/libs.versions.toml', 'build.gradle.kts', 'app/composeApp/build.gradle.kts',
    'settings.gradle.kts', 'buildSrc/src/main/kotlin/Foo.kt', 'buildSrc/build.gradle.kts'];
  const noTocan = ['app/composeApp/src/Main.kt', '.pipeline/pulpo.js', 'docs/security-sast.md',
    'gradle.properties', 'gradle/wrapper/gradle-wrapper.properties', 'backend/src/Foo.kt', 'mybuildSrc/x.kt'];
  for (const f of tocan) assert.ok(pattern.test(f), `${f} debería disparar OWASP`);
  for (const f of noTocan) assert.ok(!pattern.test(f), `${f} no debería disparar OWASP`);
});

test('#7659 detect-deps clasifica un PR real con git (merge efímero y fallback)', (t) => {
  const step = jobs['detect-deps'].steps.find((s) => s.id === 'filter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  const branch = (name, file) => {
    git('checkout', '-q', '-b', name, base);
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), name + '\n');
    git('add', '.');
    git('commit', '-q', '-m', name);
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', base);
    git('merge', '-q', '--no-ff', '-m', 'merge', head);
    return { head, merge: git('rev-parse', 'HEAD') };
  };

  const classify = ({ githubSha, head }) => {
    const out = path.join(dir, '.out-' + Math.random().toString(36).slice(2));
    fs.writeFileSync(out, '');
    execFileSync('bash', ['-c', step.run], {
      cwd: dir,
      env: { ...process.env, ...step.env, PR_BASE_SHA: base, PR_HEAD_SHA: head, GITHUB_SHA: githubSha, GITHUB_OUTPUT: out },
    });
    const value = fs.readFileSync(out, 'utf8');
    fs.rmSync(out);
    return value.trim();
  };

  const deps = branch('deps', 'gradle/libs.versions.toml');
  const code = branch('code', 'app/src/Main.kt');
  assert.equal(classify({ githubSha: deps.merge, head: deps.head }), 'deps=true');
  assert.equal(classify({ githubSha: code.merge, head: code.head }), 'deps=false');
  // Sin merge efímero (GITHUB_SHA == head): usa base...head.
  assert.equal(classify({ githubSha: deps.head, head: deps.head }), 'deps=true');
  assert.equal(classify({ githubSha: code.head, head: code.head }), 'deps=false');
  // Sin forma de calcular el diff: fail-open hacia correr OWASP.
  assert.equal(classify({ githubSha: 'deadbeef', head: '' }), 'deps=true');
});

test('#7659 secret-scan queda atado a pull_request y push, sin concurrency ni permisos extra', () => {
  const job = jobs['secret-scan'];
  assert.equal(job.if, "github.event_name == 'pull_request' || github.event_name == 'push'");
  assert.equal(job.concurrency, undefined);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.name, 'Secret scan (blocking)');
  assert.equal(job['continue-on-error'], false);
});

test('#7659 concurrency sólo a nivel job en los pesados, con grupos distintos', () => {
  assert.equal(parsedWorkflow.concurrency, undefined, 'no puede haber concurrency top-level');
  const groups = HEAVY.map((name) => {
    const c = jobs[name].concurrency;
    assert.ok(c, `${name} sin concurrency`);
    assert.equal(c['cancel-in-progress'], true);
    return c.group;
  });
  assert.equal(new Set(groups).size, groups.length, 'los grupos de concurrency se pisan entre jobs');
  // OWASP corre por PR y por schedule: el grupo separa el evento para no cancelarse entre sí.
  assert.match(jobs['dependency-check'].concurrency.group, /github\.event_name/);
});

test('#7659 permisos mínimos: global sólo contents read; semgrep sube SARIF', () => {
  assert.deepEqual(parsedWorkflow.permissions, { contents: 'read' });
  assert.deepEqual(jobs.semgrep.permissions, { contents: 'read', 'security-events': 'write' });
  const upload = jobs.semgrep.steps.find((s) => String(s.uses).startsWith('github/codeql-action/upload-sarif'));
  assert.ok(upload, 'semgrep dejó de subir el SARIF');
  for (const [name, job] of Object.entries(jobs)) {
    assert.ok(!('pull-requests' in (job.permissions || {})), `${name} pide pull-requests`);
  }
});

test('#7659 no queda sast-report y todo artefacto retiene 7 días o menos', () => {
  assert.equal(jobs['sast-report'], undefined);
  assert.doesNotMatch(workflow, /issues\.createComment|issues\.updateComment/);
  const uploads = Object.values(jobs)
    .flatMap((job) => job.steps || [])
    .filter((s) => String(s.uses).startsWith('actions/upload-artifact'));
  assert.ok(uploads.length >= 3);
  for (const s of uploads) {
    assert.ok(Number(s.with['retention-days']) <= 7, `${s.with.name} retiene más de 7 días`);
  }
});

test('#7659 sast-summary corre sólo fuera del PR, sin permisos de escritura y con el token por env', () => {
  const job = jobs['sast-summary'];
  assert.deepEqual(job.needs, ['dependency-check', 'semgrep', 'detect-secrets']);
  assert.equal(job.if, "always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')");
  assert.deepEqual(job.permissions, { contents: 'read' });
  const aviso = job.steps.find((s) => s.name === 'Avisar al operador por Telegram');
  assert.equal(aviso.if, "steps.summary.outputs.notify == 'true'");
  assert.equal(aviso['continue-on-error'], true);
  assert.equal(aviso.env.TELEGRAM_BOT_TOKEN, '${{ secrets.TELEGRAM_BOT_TOKEN }}');
  assert.equal(aviso.env.TELEGRAM_CHAT_ID, '${{ secrets.TELEGRAM_CHAT_ID }}');
  for (const step of job.steps.filter((s) => typeof s.run === 'string')) {
    assert.doesNotMatch(step.run, /\$\{\{/, `${step.name} interpola expresiones en su run`);
  }
});

// Ejecuta el script real del step "Generar resumen" contra reportes simulados.
function runSummary({ depOutcome, depReport, owaspHtml, sarif, baseline }) {
  const step = jobs['sast-summary'].steps.find((s) => s.id === 'summary');
  const script = step.run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sast-summary-'));
  try {
    const put = (rel, content) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    if (owaspHtml) put('reports/owasp/dependency-check-report.html', owaspHtml);
    if (sarif) put('reports/semgrep/semgrep.sarif', JSON.stringify(sarif));
    if (baseline) put('reports/secrets/secrets-baseline.json', JSON.stringify(baseline));
    put('summary.md', '');
    put('output.txt', '');
    fs.writeFileSync(path.join(dir, 'script.js'), script);
    execFileSync(process.execPath, ['script.js'], {
      cwd: dir,
      env: {
        ...process.env,
        DEP_OUTCOME: depOutcome,
        DEP_REPORT: depReport,
        GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
        GITHUB_OUTPUT: path.join(dir, 'output.txt'),
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'intrale/platform',
        GITHUB_RUN_ID: '123',
        RUNNER_TEMP: dir,
      },
    });
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    return {
      summary: read('summary.md'),
      output: read('output.txt'),
      aviso: read('sast-aviso.txt'),
      audio: read('sast-aviso-audio.txt'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OWASP_HTML = '<li><i>Vulnerable Dependencies</i>: <span id="vulnerableCount">175</span></li>'
  + '<li><i>Vulnerabilities Found</i>: <span id="vulnerabilityCount">2900</span></li>'
  + '<td>CVE-2099-0001</td><td>pkg:maven/org.example/lib@1.2.3</td>';

test('#7659 el resumen cuenta hallazgos y avisa sin exponer CVE ni paquete', () => {
  const r = runSummary({
    depOutcome: 'success',
    depReport: 'present',
    owaspHtml: OWASP_HTML,
    sarif: { runs: [{ results: [{ level: 'warning', message: { text: 'secreto en Foo.kt:12' } }, { level: 'error' }] }] },
    baseline: { results: { 'app/Foo.kt': [{}, {}], 'b.kt': [{}] } },
  });
  assert.match(r.summary, /2\.905 hallazgos/);
  assert.match(r.summary, /2\.900 vulnerabilidades en 175 dependencias/);
  assert.match(r.summary, /\| Semgrep \| 2 \(warning: 1, error: 1\) \|/);
  assert.match(r.summary, /3 candidatos/);
  assert.match(r.summary, /security\/code-scanning/);
  assert.match(r.output, /notify=true/);
  assert.match(r.aviso, /^El análisis de seguridad de main encontró 2\.900 vulnerabilidades en dependencias/);
  for (const text of [r.summary, r.aviso, r.audio]) {
    assert.doesNotMatch(text, /CVE-|pkg:maven|org\.example|Foo\.kt|b\.kt/);
  }
  assert.doesNotMatch(r.audio, /https?:\/\//, 'el audio no lee URLs');
});

test('#7659 una herramienta que no terminó se declara, nunca se muestra como cero', () => {
  const r = runSummary({
    depOutcome: 'failure',
    depReport: 'missing',
    sarif: { runs: [{ results: [] }] },
    baseline: { results: {} },
  });
  assert.match(r.summary, /Corrida incompleta: no terminó OWASP Dependency Check \(scan fallido\)/);
  assert.match(r.summary, /\| OWASP Dependency Check \| no terminó \(scan fallido\) \|/);
  assert.doesNotMatch(r.summary, /Sin hallazgos/);
  assert.match(r.output, /notify=true/);
  assert.match(r.aviso, /no encontró hallazgos\. Ojo: una herramienta no terminó/);
});

test('#7659 corrida limpia: veredicto sin hallazgos y sin aviso al operador', () => {
  const r = runSummary({
    depOutcome: 'success',
    depReport: 'present',
    owaspHtml: '<span id="vulnerableCount">0</span><span id="vulnerabilityCount">0</span>',
    sarif: { runs: [{ results: [] }] },
    baseline: { results: {} },
  });
  assert.match(r.summary, /Sin hallazgos/);
  assert.match(r.output, /notify=false/);
});
