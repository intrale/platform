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
