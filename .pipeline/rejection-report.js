#!/usr/bin/env node
// Genera un reporte PDF detallado cuando un agente finaliza rechazado/cancelado.
// Uso: node .pipeline/rejection-report.js --issue 123 --skill qa --fase verificacion \
//        --code 1 --elapsed 45 --motivo "razón" --log "123-qa.log" --pipeline desarrollo
//
// El reporte incluye: info técnica, funcional, contexto, recursos, análisis y sugerencia.
// Se envía automáticamente a Telegram en PDF.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PIPELINE = __dirname;
const LOG_DIR = path.join(PIPELINE, 'logs');
const METRICS_FILE = path.join(PIPELINE, 'metrics-history.jsonl');
const PROFILES_FILE = path.join(PIPELINE, 'skill-profiles.json');
const REPORT_SCRIPT = path.join(ROOT, 'scripts', 'report-to-pdf-telegram.js');

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const issue = getArg('issue') || '?';
const skill = getArg('skill') || '?';
const fase = getArg('fase') || '?';
const exitCode = getArg('code') || '?';
const elapsed = getArg('elapsed') || '?';
const motivo = getArg('motivo') || 'Sin motivo registrado';
const logFile = getArg('log') || `${issue}-${skill}.log`;
const pipeline = getArg('pipeline') || 'desarrollo';

// --- Helpers ---
function readLastLines(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-n).join('\n');
  } catch { return '(log no disponible)'; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function getRecentMetrics(minutes) {
  try {
    const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
    const cutoff = Date.now() - minutes * 60000;
    const recent = [];
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        if (s.ts >= cutoff) recent.push(s);
      } catch {}
    }
    return recent;
  } catch { return []; }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Build report ---
function generateReport() {
  const now = new Date();
  const timestamp = now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  // 1. Log del agente (últimas 80 líneas)
  const logPath = path.join(LOG_DIR, logFile);
  const logTail = readLastLines(logPath, 80);

  // 2. Recursos actuales del sistema
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsedPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const memUsedGB = ((totalMem - freeMem) / 1073741824).toFixed(1);
  const memTotalGB = (totalMem / 1073741824).toFixed(1);
  const cpuCores = os.cpus().length;

  // 3. Métricas recientes (últimos 10 min)
  const recentMetrics = getRecentMetrics(10);
  let avgCpu = 0, avgMem = 0, avgAgents = 0, pressureLevels = {};
  if (recentMetrics.length > 0) {
    avgCpu = Math.round(recentMetrics.reduce((s, m) => s + m.cpu, 0) / recentMetrics.length);
    avgMem = Math.round(recentMetrics.reduce((s, m) => s + m.mem, 0) / recentMetrics.length);
    avgAgents = (recentMetrics.reduce((s, m) => s + m.agents, 0) / recentMetrics.length).toFixed(1);
    for (const m of recentMetrics) {
      pressureLevels[m.level] = (pressureLevels[m.level] || 0) + 1;
    }
  }

  // 4. Perfil del skill
  const profiles = readJson(PROFILES_FILE) || {};
  const skillProfile = profiles[skill];

  // 5. YAML del issue (si existe en listo/)
  let yamlData = null;
  const allFases = ['analisis', 'sizing', 'dev', 'build', 'verificacion', 'entrega'];
  for (const f of allFases) {
    const listoPath = path.join(PIPELINE, pipeline, f, 'listo', `${issue}.${skill}`);
    if (fs.existsSync(listoPath)) {
      try {
        const yaml = require('js-yaml');
        yamlData = yaml.load(fs.readFileSync(listoPath, 'utf8'));
      } catch {}
      break;
    }
  }

  // 6. Cooldowns activos
  const cooldowns = readJson(path.join(PIPELINE, 'cooldowns.json')) || {};
  const cooldownKey = `${skill}:${issue}`;
  const cooldownInfo = cooldowns[cooldownKey];

  // 7. Análisis automático
  const analysis = analyzeRejection(exitCode, elapsed, motivo, logTail, avgCpu, avgMem, skill);

  // --- HTML ---
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 32px; color: #1a1a2e; line-height: 1.6; font-size: 13px; }
  h1 { color: #c0392b; border-bottom: 3px solid #c0392b; padding-bottom: 8px; font-size: 1.5em; }
  h2 { color: #2c3e50; margin-top: 24px; font-size: 1.15em; border-left: 4px solid #3498db; padding-left: 10px; }
  h3 { color: #34495e; font-size: 1em; }
  table { width: 100%; margin: 12px 0; border-collapse: collapse; }
  th, td { padding: 6px 10px; text-align: left; border: 1px solid #ddd; font-size: 0.92em; }
  th { background: #ecf0f1; font-weight: 600; }
  tr:nth-child(even) { background: #f9f9f9; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 600; }
  .badge-red { background: #fadbd8; color: #c0392b; }
  .badge-yellow { background: #fef9e7; color: #f39c12; }
  .badge-green { background: #d5f5e3; color: #27ae60; }
  .badge-blue { background: #d6eaf8; color: #2980b9; }
  pre { background: #1e1e2e; color: #cdd6f4; padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 0.82em; line-height: 1.5; max-height: 400px; overflow-y: auto; }
  code { font-family: 'Cascadia Code', 'Fira Code', monospace; }
  .metric-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0; }
  .metric-card { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 10px 14px; min-width: 120px; flex: 1; }
  .metric-value { font-size: 1.4em; font-weight: 700; color: #2c3e50; }
  .metric-label { font-size: 0.8em; color: #7f8c8d; }
  .analysis-box { background: #fef9e7; border-left: 4px solid #f39c12; padding: 14px; margin: 12px 0; border-radius: 0 6px 6px 0; }
  .solution-box { background: #d5f5e3; border-left: 4px solid #27ae60; padding: 14px; margin: 12px 0; border-radius: 0 6px 6px 0; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 0.8em; color: #999; text-align: center; }
</style>
</head><body>

<h1>Reporte de Rechazo &mdash; #${escapeHtml(issue)} ${escapeHtml(skill)}</h1>
<p><span class="badge badge-red">RECHAZADO</span> &nbsp; ${escapeHtml(timestamp)}</p>

<h2>Informacion del Agente</h2>
<table>
  <tr><th>Issue</th><td>#${escapeHtml(issue)}</td><th>Skill</th><td>${escapeHtml(skill)}</td></tr>
  <tr><th>Fase</th><td>${escapeHtml(fase)}</td><th>Pipeline</th><td>${escapeHtml(pipeline)}</td></tr>
  <tr><th>Codigo de salida</th><td>${exitCode === '0' ? '<span class="badge badge-green">0 (OK)</span>' : '<span class="badge badge-red">' + escapeHtml(exitCode) + '</span>'}</td><th>Duracion</th><td>${escapeHtml(elapsed)}s</td></tr>
  <tr><th>Motivo</th><td colspan="3">${escapeHtml(motivo)}</td></tr>
  ${cooldownInfo ? '<tr><th>Cooldown</th><td colspan="3">Fallo #' + cooldownInfo.failures + ' &mdash; cooldown hasta ' + escapeHtml(cooldownInfo.cooldownUntil || 'N/A') + '</td></tr>' : ''}
  ${yamlData && yamlData.rebote_numero ? '<tr><th>Rebotes</th><td colspan="3">#' + yamlData.rebote_numero + ' en fase ' + escapeHtml(yamlData.rebote_en_fase || '?') + '</td></tr>' : ''}
</table>

<h2>Recursos del Sistema</h2>
<div class="metric-row">
  <div class="metric-card">
    <div class="metric-value">${memUsedPct}%</div>
    <div class="metric-label">RAM (${memUsedGB}/${memTotalGB} GB)</div>
  </div>
  <div class="metric-card">
    <div class="metric-value">${avgCpu}%</div>
    <div class="metric-label">CPU promedio (10 min)</div>
  </div>
  <div class="metric-card">
    <div class="metric-value">${avgAgents}</div>
    <div class="metric-label">Agentes promedio</div>
  </div>
  <div class="metric-card">
    <div class="metric-value">${cpuCores}</div>
    <div class="metric-label">CPU cores</div>
  </div>
</div>
${recentMetrics.length > 0 ? `
<table>
  <tr><th>Nivel de presion</th><th>Snapshots</th><th>Proporcion</th></tr>
  ${Object.entries(pressureLevels).sort((a,b) => b[1] - a[1]).map(([level, count]) => {
    const pct = Math.round(count / recentMetrics.length * 100);
    const cls = level === 'red' ? 'badge-red' : level === 'orange' ? 'badge-yellow' : level === 'yellow' ? 'badge-yellow' : 'badge-green';
    return '<tr><td><span class="badge ' + cls + '">' + level.toUpperCase() + '</span></td><td>' + count + '/' + recentMetrics.length + '</td><td>' + pct + '%</td></tr>';
  }).join('')}
</table>` : '<p><em>Sin metricas recientes disponibles</em></p>'}

${skillProfile ? `
<h2>Perfil Historico del Skill: ${escapeHtml(skill)}</h2>
<table>
  <tr><th>CPU promedio</th><td>${skillProfile.avgCpu}%</td><th>RAM promedio</th><td>${skillProfile.avgMem}%</td></tr>
  <tr><th>Muestras</th><td>${skillProfile.samples}</td><th>Ultima actualizacion</th><td>${escapeHtml(skillProfile.lastUpdated || 'N/A')}</td></tr>
</table>` : ''}

<h2>Analisis de la Situacion</h2>
<div class="analysis-box">
  <h3>Conclusion</h3>
  <p>${escapeHtml(analysis.conclusion)}</p>
  ${analysis.factors.length > 0 ? '<h3>Factores contribuyentes</h3><ul>' + analysis.factors.map(f => '<li>' + escapeHtml(f) + '</li>').join('') + '</ul>' : ''}
</div>

<h2>Solucion Sugerida</h2>
<div class="solution-box">
  <p>${escapeHtml(analysis.suggestion)}</p>
  ${analysis.steps.length > 0 ? '<h3>Pasos recomendados</h3><ol>' + analysis.steps.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ol>' : ''}
</div>

<h2>Log del Agente (ultimas 80 lineas)</h2>
<pre><code>${escapeHtml(logTail)}</code></pre>

<div class="footer">
  Intrale Platform &mdash; Reporte de Rechazo &mdash; ${escapeHtml(now.toISOString().slice(0, 10))}
</div>
</body></html>`;
}

// --- Análisis automático basado en patrones ---
function analyzeRejection(code, elapsed, motivo, logTail, avgCpu, avgMem, skill) {
  const result = { conclusion: '', factors: [], suggestion: '', steps: [] };
  const motivoLower = (motivo || '').toLowerCase();
  const logLower = (logTail || '').toLowerCase();
  const elapsedNum = parseFloat(elapsed) || 0;
  const codeNum = parseInt(code) || -1;

  // Muerte prematura (<15s)
  if (elapsedNum < 15) {
    result.conclusion = 'El agente murio prematuramente (menos de 15 segundos). Esto indica un fallo de infraestructura, no un problema funcional.';
    result.factors.push('Tiempo de ejecucion extremadamente corto (' + elapsed + 's)');
    if (avgCpu > 80) result.factors.push('CPU en estado critico (' + avgCpu + '%)');
    if (avgMem > 85) result.factors.push('RAM en estado critico (' + avgMem + '%)');
    if (logLower.includes('eaddrinuse')) result.factors.push('Puerto en uso — conflicto de procesos');
    if (logLower.includes('enomem') || logLower.includes('out of memory')) result.factors.push('Sistema sin memoria disponible');
    if (logLower.includes('module_not_found') || logLower.includes('cannot find module')) result.factors.push('Dependencia faltante en el entorno');
    result.suggestion = 'Verificar el estado del sistema y reintentar. Si es recurrente, revisar los logs para identificar el error de arranque.';
    result.steps = ['Verificar recursos del sistema (CPU/RAM)', 'Revisar las primeras lineas del log para el error inicial', 'Verificar que el worktree y dependencias esten intactos', 'Reintentar manualmente si el sistema esta estable'];
    return result;
  }

  // Evidencia QA incompleta
  if (motivoLower.includes('evidencia') || motivoLower.includes('video')) {
    result.conclusion = 'El agente QA termino sin generar evidencia completa (video, audio o screenshots). El gate de evidencia automatico rechazo la ejecucion.';
    result.factors.push('Gate de evidencia on-exit rechazo el resultado');
    if (motivoLower.includes('video_size')) result.factors.push('Video ausente o demasiado pequeno (<200KB)');
    if (motivoLower.includes('audio')) result.factors.push('Video sin narracion de audio');
    if (motivoLower.includes('no encontrado')) result.factors.push('Archivo de video no encontrado en disco');
    result.suggestion = 'Re-ejecutar la validacion QA asegurandose de que el emulador este corriendo y el screenrecord funcione correctamente.';
    result.steps = ['Verificar que el emulador Android este levantado', 'Confirmar que screenrecord tiene permisos', 'Re-ejecutar /qa validate para el issue', 'Si persiste, revisar la configuracion de qa-android.sh'];
    return result;
  }

  // Errores de compilacion/build
  if (motivoLower.includes('build') || motivoLower.includes('compilation') || logLower.includes('build failed') || logLower.includes('compilation error')) {
    result.conclusion = 'El agente fallo durante la fase de build/compilacion. Los cambios de codigo introdujeron errores que impiden la compilacion.';
    result.factors.push('Error de compilacion detectado');
    if (logLower.includes('unresolved reference')) result.factors.push('Referencia a simbolo no resuelto');
    if (logLower.includes('type mismatch')) result.factors.push('Error de tipos en el codigo');
    if (avgMem > 80) result.factors.push('RAM alta — Gradle puede quedarse sin heap');
    result.suggestion = 'Revisar los errores de compilacion en el log y corregir el codigo fuente. Si es un problema de memoria, reducir la concurrencia de agentes.';
    result.steps = ['Leer el log buscando "error:" o "FAILED"', 'Identificar los archivos y lineas con errores', 'Corregir el codigo fuente', 'Ejecutar ./gradlew check --no-daemon localmente antes de reintentar'];
    return result;
  }

  // Tests fallando
  if (motivoLower.includes('test') || logLower.includes('test failed') || logLower.includes('tests failed') || logLower.includes('assertion')) {
    result.conclusion = 'Los tests automaticos fallaron durante la ejecucion del agente. Esto puede indicar una regresion o un test mal escrito.';
    result.factors.push('Fallos en tests automaticos');
    if (logLower.includes('timeout')) result.factors.push('Posible timeout en tests (sistema lento o test inestable)');
    result.suggestion = 'Identificar los tests fallidos, verificar si son regresiones reales o tests flaky, y corregir el codigo o los tests segun corresponda.';
    result.steps = ['Buscar "FAILED" en el log para identificar tests especificos', 'Ejecutar los tests fallidos localmente para reproducir', 'Si es flaky, agregar retry o estabilizar el test', 'Si es regresion, corregir el codigo de produccion'];
    return result;
  }

  // Review rechazado
  if (motivoLower.includes('review') || motivoLower.includes('bloqueante')) {
    result.conclusion = 'El code review automatico encontro problemas bloqueantes en el codigo. El agente debe corregir los hallazgos antes de continuar.';
    result.factors.push('Code review rechazo el PR');
    if (motivoLower.includes('string')) result.factors.push('Violacion de convenciones de strings');
    if (motivoLower.includes('logger')) result.factors.push('Logger faltante en clase nueva');
    result.suggestion = 'Revisar los comentarios del code review y aplicar las correcciones sugeridas. Los bloqueantes deben resolverse antes de reintentar.';
    result.steps = ['Leer el feedback del review en los comentarios del PR', 'Aplicar las correcciones bloqueantes', 'Verificar convenciones de CLAUDE.md', 'Re-ejecutar el delivery'];
    return result;
  }

  // Saturacion de recursos
  if (avgCpu > 75 || avgMem > 85) {
    result.conclusion = 'El sistema estaba bajo alta carga de recursos durante la ejecucion. Es probable que la falta de CPU/RAM haya causado inestabilidad o timeouts.';
    result.factors.push('CPU promedio alto: ' + avgCpu + '%');
    result.factors.push('RAM promedio alto: ' + avgMem + '%');
    if (avgMem > 85) result.factors.push('RAM critica — posibles OOM kills');
    result.suggestion = 'Esperar a que el sistema se estabilice (presion GREEN) antes de reintentar. Considerar reducir la concurrencia de agentes.';
    result.steps = ['Verificar la presion actual del sistema', 'Si esta en YELLOW/ORANGE/RED, esperar', 'Matar procesos zombies (Gradle daemons, etc.)', 'Reintentar cuando la presion baje a GREEN'];
    return result;
  }

  // Timeout / ejecucion larga
  if (elapsedNum > 3600) {
    result.conclusion = 'El agente estuvo corriendo por mas de ' + Math.round(elapsedNum / 60) + ' minutos antes de fallar. Esto sugiere un proceso que se quedo trabado o un scope demasiado grande.';
    result.factors.push('Duracion excesiva: ' + Math.round(elapsedNum / 60) + ' minutos');
    result.suggestion = 'Verificar si el agente se quedo en un loop o si el issue es demasiado complejo para una sola ejecucion. Considerar dividir el trabajo.';
    result.steps = ['Revisar el log buscando patrones repetitivos (loops)', 'Verificar si el issue tiene un scope demasiado grande', 'Considerar dividir en sub-issues mas pequeños', 'Reintentar con un scope mas acotado'];
    return result;
  }

  // Genérico
  result.conclusion = 'El agente termino con codigo ' + code + ' despues de ' + elapsed + 's. El motivo reportado fue: "' + motivo + '". Se requiere revision manual del log para determinar la causa exacta.';
  result.factors.push('Codigo de salida: ' + code);
  if (codeNum !== 0) result.factors.push('Terminacion anormal (no-zero exit code)');
  result.suggestion = 'Revisar el log completo del agente para identificar el punto exacto de falla. Buscar errores, excepciones o mensajes de rechazo en las ultimas lineas.';
  result.steps = ['Abrir el log viewer en el dashboard para el issue #' + issue, 'Buscar "error", "FAILED", "rechazado" en el log', 'Identificar la seccion donde ocurrio el fallo', 'Corregir el problema y reintentar'];
  return result;
}

// --- Main ---
async function main() {
  try {
    console.log(`[rejection-report] Generando reporte para #${issue} ${skill} (${fase})...`);
    const html = generateReport();

    // Escribir HTML temporal
    const tmpDir = path.join(PIPELINE, 'logs');
    const htmlPath = path.join(tmpDir, `rejection-${issue}-${skill}.html`);
    fs.writeFileSync(htmlPath, html);

    // Generar PDF y enviar a Telegram
    execSync(`node "${REPORT_SCRIPT}" "${htmlPath}" "Rechazo #${issue} ${skill} (${fase})"`, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 120000
    });

    // Copiar el PDF generado a logs/ para que el dashboard pueda servirlo
    const pdfName = `rejection-${issue}-${skill}.pdf`;
    const pdfDest = path.join(LOG_DIR, pdfName);
    const possiblePdfPaths = [
      htmlPath.replace(/\.html$/, '.pdf'),
      path.join(ROOT, 'docs', 'qa', pdfName),
    ];
    for (const src of possiblePdfPaths) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, pdfDest);
        console.log(`[rejection-report] PDF copiado a ${pdfDest}`);
        // Limpiar el original si no está en logs/
        if (src !== pdfDest) try { fs.unlinkSync(src); } catch {}
        break;
      }
    }

    // Limpiar HTML temporal y copia en docs/qa
    try { fs.unlinkSync(htmlPath); } catch {}
    try { fs.unlinkSync(path.join(ROOT, 'docs', 'qa', `rejection-${issue}-${skill}.html`)); } catch {}

    console.log(`[rejection-report] Reporte enviado a Telegram para #${issue} ${skill}`);
  } catch (e) {
    console.error(`[rejection-report] Error: ${e.message}`);
    process.exit(1);
  }
}

main();
