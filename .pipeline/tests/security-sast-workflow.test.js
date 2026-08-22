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
