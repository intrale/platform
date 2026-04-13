#!/usr/bin/env node
// Genera un reporte PDF detallado cuando un agente finaliza rechazado/cancelado.
//
// Fase 1 (collect — default):
//   node .pipeline/rejection-report.js --issue 123 --skill qa --fase verificacion \
//     --code 1 --elapsed 45 --motivo "razón" --log "123-qa.log" --pipeline desarrollo
//   Si detecta dependencias externas: persiste contexto + encola create-issue en servicio-github.
//   Si no: genera PDF + audio directo.
//
// Fase 2 (complete — invocada por onComplete del condensador):
//   node .pipeline/rejection-report.js --phase=complete --context=/path/context.json --results=/path/results.json
//   Lee contexto + resultados de issues creados, genera PDF + audio, encola comment + label.

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
const GH_CLI = process.env.GH_CLI_PATH || '/c/Workspaces/gh-cli/bin/gh';
const GH_QUEUE_DIR = path.join(PIPELINE, 'servicios', 'github', 'pendiente');

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
// Soporte para --name=value
function getArgEq(name) {
  const prefix = '--' + name + '=';
  const found = args.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const phase = getArg('phase') || getArgEq('phase') || 'collect';
const resultsFile = getArg('results') || getArgEq('results') || null;
const contextFile = getArg('context') || getArgEq('context') || null;

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

// --- Contexto del issue desde GitHub ---
function fetchIssueContext(issueNum) {
  try {
    const ghPath = fs.existsSync(GH_CLI) ? GH_CLI : 'gh';
    const raw = execSync(
      `"${ghPath}" issue view ${issueNum} --json title,body,labels --repo intrale/platform`,
      { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const data = JSON.parse(raw);
    const bodyLines = (data.body || '').split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('-'));
    const summary = bodyLines.slice(0, 3).join(' ').substring(0, 300);
    return {
      title: data.title || `Issue #${issueNum}`,
      labels: (data.labels || []).map(l => l.name),
      summary: summary || '(sin descripción)',
    };
  } catch {
    return { title: `Issue #${issueNum}`, labels: [], summary: '(no se pudo obtener del repositorio)' };
  }
}

// --- Historial de rechazos previos del mismo issue ---
function getRejectHistory(issueNum) {
  const history = [];
  const allFases = ['analisis', 'sizing', 'dev', 'build', 'verificacion', 'entrega'];
  const pipelines = ['desarrollo'];
  for (const pip of pipelines) {
    for (const f of allFases) {
      for (const sub of ['listo', 'procesado']) {
        const dir = path.join(PIPELINE, pip, f, sub);
        try {
          const files = fs.readdirSync(dir).filter(fn => fn.startsWith(issueNum + '.'));
          for (const fn of files) {
            try {
              const yaml = require('js-yaml');
              const data = yaml.load(fs.readFileSync(path.join(dir, fn), 'utf8'));
              if (data && data.resultado === 'rechazado') {
                history.push({
                  skill: fn.split('.').slice(1).join('.'),
                  fase: f,
                  motivo: data.motivo || 'Sin motivo',
                  rechazadoPor: data.rechazado_por || 'desconocido',
                });
              }
            } catch {}
          }
        } catch {}
      }
    }
  }
  try {
    const pdfFiles = fs.readdirSync(path.join(ROOT, 'docs', 'qa'))
      .filter(f => f.startsWith(`rejection-${issueNum}-`) && f.endsWith('.pdf'));
    for (const pf of pdfFiles) {
      const skillMatch = pf.match(/rejection-\d+-(.+)\.pdf/);
      if (skillMatch && !history.find(h => h.skill === skillMatch[1])) {
        history.push({ skill: skillMatch[1], fase: '?', motivo: '(ver PDF anterior)', rechazadoPor: 'pipeline' });
      }
    }
  } catch {}
  return history;
}

// --- Estado de los otros gates para este issue ---
function getGateStatus(issueNum) {
  const gates = [];
  const verifyDir = path.join(PIPELINE, 'desarrollo', 'verificacion', 'listo');
  try {
    const files = fs.readdirSync(verifyDir).filter(fn => fn.startsWith(issueNum + '.'));
    for (const fn of files) {
      try {
        const yaml = require('js-yaml');
        const data = yaml.load(fs.readFileSync(path.join(verifyDir, fn), 'utf8'));
        const sk = fn.split('.').slice(1).join('.');
        gates.push({ skill: sk, resultado: data.resultado || '?', motivo: data.motivo || '' });
      } catch {}
    }
  } catch {}
  return gates;
}

// --- Clasificación de causa raíz ---
function classifyRootCause(motivo, logTail, exitCode) {
  const motivoLower = (motivo || '').toLowerCase();
  const logLower = (logTail || '').toLowerCase();

  if (logLower.includes('enotfound') || logLower.includes('econnrefused') || logLower.includes('unable to connect'))
    return { tipo: 'INFRAESTRUCTURA', emoji: '🔌', origen: 'EXTERNO',
      desc: 'El agente no pudo conectarse a internet o a un servicio externo. No tiene nada que ver con el código del issue.',
      negocio: 'La prueba no se ejecutó porque hubo un problema de red. El código no fue evaluado.' };
  if (logLower.includes('enomem') || logLower.includes('out of memory') || logLower.includes('heap'))
    return { tipo: 'INFRAESTRUCTURA', emoji: '🔌', origen: 'EXTERNO',
      desc: 'El servidor se quedó sin memoria disponible.',
      negocio: 'La máquina no tenía recursos suficientes para correr la prueba. No es un problema del código.' };
  if (logLower.includes('eaddrinuse'))
    return { tipo: 'INFRAESTRUCTURA', emoji: '🔌', origen: 'EXTERNO',
      desc: 'Un puerto de red estaba ocupado por otro proceso.',
      negocio: 'Conflicto de procesos en el servidor. No es un problema del código.' };
  if (motivoLower.includes('muerte prematura') || (parseFloat(exitCode) !== 0 && logTail && logTail.split('\n').filter(Boolean).length <= 3))
    return { tipo: 'INFRAESTRUCTURA', emoji: '🔌', origen: 'EXTERNO',
      desc: 'El agente no pudo arrancar correctamente (murió en menos de 15 segundos).',
      negocio: 'El proceso de validación falló al iniciar. Es un problema del entorno, no del código.' };

  if (motivoLower.includes('evidencia') || motivoLower.includes('video')) {
    const hasExternalCrash = logLower.includes('unexpected json') || logLower.includes('crash') ||
      logLower.includes('exception') && !logLower.includes('doxxexception');
    return { tipo: 'QA-EVIDENCIA', emoji: '📹',
      origen: hasExternalCrash ? 'EXTERNO' : 'INTERNO',
      desc: hasExternalCrash
        ? 'El agente QA no pudo generar evidencia porque la app crasheó antes de llegar a la pantalla del feature.'
        : 'El agente QA ejecutó pero no generó el video/audio de evidencia requerido.',
      negocio: hasExternalCrash
        ? 'La app tiene un bug en otra pantalla que impide llegar a probar esta funcionalidad. El feature en sí no fue evaluado.'
        : 'La prueba se ejecutó pero no se grabó correctamente el video. Puede ser un problema técnico de grabación.' };
  }

  if (motivoLower.includes('build') || motivoLower.includes('compilation') || logLower.includes('build failed'))
    return { tipo: 'COMPILACION', emoji: '🔨', origen: 'INTERNO',
      desc: 'El código no compila — errores en el código fuente.',
      negocio: 'Los cambios de código tienen errores que impiden generar la aplicación. El desarrollador debe corregirlos.' };

  if (motivoLower.includes('test') || logLower.includes('test failed') || logLower.includes('assertion'))
    return { tipo: 'TESTS', emoji: '🧪', origen: 'INTERNO',
      desc: 'Tests automáticos fallaron — posible regresión.',
      negocio: 'Las pruebas automáticas detectaron que algo se rompió. Puede ser un bug nuevo o un test que hay que actualizar.' };

  if (motivoLower.includes('review') || motivoLower.includes('bloqueante'))
    return { tipo: 'CODE-REVIEW', emoji: '👁️', origen: 'INTERNO',
      desc: 'El code review encontró problemas bloqueantes en el código.',
      negocio: 'La revisión de código encontró problemas de calidad que deben corregirse antes de continuar.' };

  if (motivoLower.includes('funcional') || motivoLower.includes('criterio') || motivoLower.includes('acceptance'))
    return { tipo: 'FUNCIONAL', emoji: '❌', origen: 'INTERNO',
      desc: 'El feature no cumple los criterios de aceptación.',
      negocio: 'La funcionalidad no hace lo que se pidió. Hay que revisar los requisitos y corregir la implementación.' };

  if (logLower.includes('feature faltante') || logLower.includes('depende de') || logLower.includes('bloqueado por'))
    return { tipo: 'DEPENDENCIA', emoji: '🔗', origen: 'EXTERNO',
      desc: 'El issue depende de otro feature o corrección que aún no existe.',
      negocio: 'Esta funcionalidad necesita que primero se construya o corrija otra parte del sistema.' };

  return { tipo: 'DESCONOCIDO', emoji: '❓', origen: 'INDETERMINADO',
    desc: 'Causa no clasificada automáticamente — requiere revisión del log.',
    negocio: 'No se pudo determinar automáticamente por qué falló. Requiere revisión manual.' };
}

// --- Extraer líneas significativas del log ---
function extractMeaningfulLog(logTail, maxLines) {
  if (!logTail) return '(log no disponible)';
  const lines = logTail.split('\n');
  const meaningful = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message && obj.message.content) {
        for (const c of obj.message.content) {
          if (c.type === 'text' && c.text) {
            const txt = c.text.length > 200 ? c.text.substring(0, 200) + '...' : c.text;
            meaningful.push('[Agente] ' + txt);
          }
        }
      } else if (obj.type === 'user' && obj.tool_use_result) {
        const stdout = obj.tool_use_result.stdout || '';
        if (stdout.includes('error') || stdout.includes('FAILED') || stdout.includes('Exception')) {
          const txt = stdout.length > 200 ? stdout.substring(0, 200) + '...' : stdout;
          meaningful.push('[Resultado] ' + txt);
        }
      }
      continue;
    } catch {}
    if (line.trim() && !line.startsWith('{')) {
      meaningful.push(line);
    }
  }
  if (meaningful.length === 0) return lines.slice(-maxLines).join('\n');
  return meaningful.slice(-maxLines).join('\n');
}

// --- Detectar dependencias externas en el log ---
function detectExternalDependencies(logTail, motivo) {
  const deps = [];
  const logLower = (logTail || '').toLowerCase();
  const motivoLower = (motivo || '').toLowerCase();
  const combined = logLower + ' ' + motivoLower;

  if (combined.includes('unexpected json') || combined.includes('unknownkeyexception'))
    deps.push('Bug en parser JSON de otro servicio — la app crashea antes de llegar al feature bajo prueba');
  if (combined.includes('clientsearchbusinesses') || combined.includes('dashboard') && combined.includes('crash'))
    deps.push('Bug en el Dashboard / listado de negocios (ClientSearchBusinessesService) que bloquea la navegacion');
  if (combined.includes('ignoreunknownkeys'))
    deps.push('Falta ignoreUnknownKeys en un servicio client — el backend devuelve campos que el cliente no conoce');

  const featurePatterns = [
    /no\s+(?:existe|implementad[oa]|disponible)\s+(?:la?\s+)?(?:pantalla|screen|feature|funcionalidad)\s+(?:de\s+)?(\w[\w\s]{3,30})/gi,
    /falta\s+(?:implementar|construir|crear)\s+(\w[\w\s]{3,30})/gi,
    /depende\s+de\s+(?:#(\d+)|(\w[\w\s]{3,30}))/gi,
    /bloqueado\s+por\s+(?:#(\d+)|(\w[\w\s]{3,30}))/gi,
  ];
  for (const pattern of featurePatterns) {
    let match;
    while ((match = pattern.exec(logTail || '')) !== null) {
      const dep = (match[1] || match[2] || match[3] || '').trim();
      if (dep && dep.length > 3 && !deps.includes(dep)) deps.push(dep);
    }
  }

  return deps;
}

// --- Buscar issues de dependencia creados en GitHub ---
function fetchDependencyIssues(issueNum) {
  try {
    const ghPath = fs.existsSync(GH_CLI) ? GH_CLI : 'gh';
    const raw = execSync(
      `"${ghPath}" issue list --label "qa:dependency" --json number,title,state,url --repo intrale/platform --limit 50`,
      { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const allDeps = JSON.parse(raw || '[]');

    let isBlocked = false;
    try {
      const issueRaw = execSync(
        `"${ghPath}" issue view ${issueNum} --json labels --repo intrale/platform`,
        { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString();
      const issueData = JSON.parse(issueRaw);
      isBlocked = (issueData.labels || []).some(l => l.name === 'blocked:dependencies');
    } catch {}

    let linkedDeps = [];
    try {
      const commentsRaw = execSync(
        `"${ghPath}" issue view ${issueNum} --json comments --repo intrale/platform`,
        { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString();
      const comments = JSON.parse(commentsRaw).comments || [];
      for (const c of comments) {
        const body = c.body || '';
        const matches = body.match(/#(\d+)/g);
        if (matches && (body.toLowerCase().includes('dependencia') || body.toLowerCase().includes('bloqueado') || body.toLowerCase().includes('dependency'))) {
          for (const m of matches) {
            const num = parseInt(m.slice(1));
            if (num !== parseInt(issueNum)) {
              const depInfo = allDeps.find(d => d.number === num);
              if (depInfo) linkedDeps.push(depInfo);
              else linkedDeps.push({ number: num, title: `Issue #${num}`, state: 'OPEN', url: '' });
            }
          }
        }
      }
    } catch {}

    const seen = new Set();
    linkedDeps = linkedDeps.filter(d => {
      if (seen.has(d.number)) return false;
      seen.add(d.number);
      return true;
    });

    return { isBlocked, linkedDeps };
  } catch {
    return { isBlocked: false, linkedDeps: [] };
  }
}

// --- Análisis automático basado en patrones ---
function analyzeRejection(code, elapsed, motivo, logTail, avgCpu, avgMem, skill) {
  const result = { conclusion: '', factors: [], suggestion: '', steps: [], externalDeps: [] };
  const motivoLower = (motivo || '').toLowerCase();
  const logLower = (logTail || '').toLowerCase();
  const elapsedNum = parseFloat(elapsed) || 0;
  const codeNum = parseInt(code) || -1;

  result.externalDeps = detectExternalDependencies(logTail, motivo);

  if (elapsedNum < 15) {
    result.conclusion = 'El agente murio en menos de 15 segundos. Esto es un fallo del entorno (servidor, red, recursos), no del codigo del issue. La funcionalidad no fue evaluada.';
    result.factors.push('Tiempo de ejecucion extremadamente corto (' + elapsed + 's)');
    if (avgCpu > 80) result.factors.push('CPU en estado critico (' + avgCpu + '%) — la maquina estaba sobrecargada');
    if (avgMem > 85) result.factors.push('RAM en estado critico (' + avgMem + '%) — no habia memoria suficiente');
    if (logLower.includes('eaddrinuse')) result.factors.push('Puerto en uso — otro proceso estaba ocupando el recurso');
    if (logLower.includes('enomem') || logLower.includes('out of memory')) result.factors.push('El sistema se quedo sin memoria');
    if (logLower.includes('module_not_found') || logLower.includes('cannot find module')) result.factors.push('Falta una dependencia en el entorno de ejecucion');
    result.suggestion = 'Reintentar cuando el sistema este estable. No requiere cambios en el codigo del issue.';
    result.steps = ['Esperar a que el sistema baje la carga (CPU < 70%, RAM < 80%)', 'Verificar que no haya procesos zombies consumiendo recursos', 'Reintentar automaticamente — el pipeline lo maneja'];
    return result;
  }

  if (motivoLower.includes('evidencia') || motivoLower.includes('video')) {
    const hasExternalBlocker = logLower.includes('crash') || logLower.includes('unexpected json') ||
      logLower.includes('exception') && !logLower.includes('el feature');
    if (hasExternalBlocker) {
      result.conclusion = 'El agente QA intento probar el feature pero la app tiene un bug en OTRA pantalla que impide llegar a la funcionalidad. El rechazo dice "evidencia incompleta" pero la causa real es que la app crashea antes de poder probar nada.';
      result.factors.push('La app crashea antes de llegar al feature bajo prueba');
      result.factors.push('El rechazo por "evidencia incompleta" es un SINTOMA, no la causa');
      if (logLower.includes('unexpected json')) result.factors.push('Error de parsing JSON: el backend devuelve campos que la app no conoce');
      result.suggestion = 'Corregir el bug bloqueante en otra parte de la app (ver dependencias externas abajo). Este issue NO necesita cambios.';
      result.steps = ['Identificar el bug que crashea la app (ver log)', 'Crear un issue separado para corregir ese bug', 'Marcar este issue como bloqueado por el nuevo issue', 'Reintentar QA una vez que el bug bloqueante este corregido'];
    } else {
      result.conclusion = 'El agente QA ejecuto la prueba pero no genero evidencia valida (video o audio). Puede ser un problema tecnico de grabacion (emulador, screenrecord, permisos).';
      result.factors.push('Gate de evidencia on-exit rechazo el resultado');
      if (motivoLower.includes('video_size')) result.factors.push('Video ausente o demasiado pequeno (<200KB)');
      if (motivoLower.includes('audio')) result.factors.push('Video sin narracion de audio');
      if (motivoLower.includes('no encontrado')) result.factors.push('Archivo de video no encontrado en disco');
      result.suggestion = 'Verificar que el emulador este corriendo y que screenrecord funcione. Reintentar la prueba QA.';
      result.steps = ['Verificar que el emulador Android este levantado y respondiendo', 'Confirmar que screenrecord tiene permisos y espacio', 'Re-ejecutar la validacion QA'];
    }
    return result;
  }

  if (motivoLower.includes('build') || motivoLower.includes('compilation') || logLower.includes('build failed') || logLower.includes('compilation error')) {
    result.conclusion = 'El codigo tiene errores de compilacion — no se puede generar la aplicacion. El desarrollador debe revisar y corregir los errores marcados en el log.';
    result.factors.push('Error de compilacion detectado');
    if (logLower.includes('unresolved reference')) result.factors.push('Se usa una funcion o variable que no existe (referencia no resuelta)');
    if (logLower.includes('type mismatch')) result.factors.push('Error de tipos: se pasa un dato incorrecto a una funcion');
    if (avgMem > 80) result.factors.push('RAM alta (' + avgMem + '%) — Gradle puede haberse quedado sin memoria');
    result.suggestion = 'El desarrollador debe corregir los errores de compilacion y verificar que el build pase localmente antes de reintentar.';
    result.steps = ['Leer el log buscando "error:" — ahi estan los errores con archivo y linea', 'Corregir cada error de compilacion', 'Ejecutar ./gradlew check --no-daemon localmente para verificar', 'Re-entregar cuando compile sin errores'];
    return result;
  }

  if (motivoLower.includes('test') || logLower.includes('test failed') || logLower.includes('tests failed') || logLower.includes('assertion')) {
    result.conclusion = 'Las pruebas automaticas fallaron. Esto puede significar que los cambios rompieron algo que funcionaba antes (regresion) o que un test necesita actualizarse para reflejar el nuevo comportamiento.';
    result.factors.push('Fallos en tests automaticos');
    if (logLower.includes('timeout')) result.factors.push('Posible timeout: el test tardo demasiado (sistema lento o test inestable)');
    result.suggestion = 'Identificar que tests fallaron, verificar si es una regresion real o un test desactualizado, y corregir.';
    result.steps = ['Buscar "FAILED" en el log para ver que tests especificos fallaron', 'Ejecutar esos tests localmente para reproducir', 'Si el test esta correcto: corregir el codigo de produccion', 'Si el test esta desactualizado: actualizar el test'];
    return result;
  }

  if (motivoLower.includes('review') || motivoLower.includes('bloqueante')) {
    result.conclusion = 'La revision de codigo encontro problemas de calidad que deben corregirse. Estos pueden ser violaciones de convenciones del proyecto, problemas de seguridad, o codigo que no sigue los patrones establecidos.';
    result.factors.push('Code review rechazo el PR');
    if (motivoLower.includes('string')) result.factors.push('Violacion de convenciones de strings (usar resString en vez de stringResource)');
    if (motivoLower.includes('logger')) result.factors.push('Falta logger en una clase nueva (obligatorio segun CLAUDE.md)');
    result.suggestion = 'Aplicar las correcciones bloqueantes del review. Los comentarios del PR detallan que hay que cambiar.';
    result.steps = ['Leer los comentarios del code review en el PR', 'Aplicar cada correccion bloqueante', 'Verificar que se cumplen las convenciones de CLAUDE.md', 'Re-entregar el PR corregido'];
    return result;
  }

  if (avgCpu > 75 || avgMem > 85) {
    result.conclusion = 'La maquina estaba sobrecargada durante la ejecucion. No es un problema del codigo — es un problema de recursos del servidor. El agente fallo por falta de CPU o memoria, no por un bug.';
    result.factors.push('CPU promedio: ' + avgCpu + '% (la maquina estaba sobrecargada)');
    result.factors.push('RAM promedio: ' + avgMem + '% (poca memoria disponible)');
    if (avgMem > 85) result.factors.push('RAM critica — el sistema puede haber matado procesos por falta de memoria');
    result.suggestion = 'Esperar a que el servidor se desocupe y reintentar. No requiere cambios en el codigo.';
    result.steps = ['Esperar a que la carga baje (CPU < 70%, RAM < 80%)', 'Matar Gradle daemons o procesos zombies si los hay', 'El pipeline reintentara automaticamente'];
    return result;
  }

  if (parseFloat(elapsed) > 3600) {
    const mins = Math.round(parseFloat(elapsed) / 60);
    result.conclusion = 'El agente estuvo corriendo ' + mins + ' minutos sin terminar. Puede haberse trabado en un loop, o el issue es demasiado grande para una sola ejecucion.';
    result.factors.push('Duracion excesiva: ' + mins + ' minutos');
    result.suggestion = 'Revisar si el agente se quedo en un loop o si el issue necesita dividirse en partes mas chicas.';
    result.steps = ['Revisar el log buscando patrones repetitivos', 'Si el issue tiene scope muy grande, dividirlo en sub-issues', 'Reintentar con un scope mas acotado'];
    return result;
  }

  result.conclusion = 'El agente termino con un error (codigo ' + code + ') despues de ' + elapsed + ' segundos. El motivo reportado fue: "' + motivo + '". Requiere revision manual del log para determinar la causa exacta.';
  result.factors.push('Codigo de salida: ' + code + (parseInt(code) !== 0 ? ' (terminacion anormal)' : ''));
  result.suggestion = 'Revisar el log del agente buscando errores, excepciones o mensajes de rechazo.';
  result.steps = ['Abrir el log del issue #' + issue + ' en el dashboard', 'Buscar "error", "FAILED", "rechazado" en el log', 'Identificar donde ocurrio el fallo y corregir'];
  return result;
}

// =============================================================================
// collectReportData() — recolecta todos los datos necesarios para el reporte
// =============================================================================
function collectReportData() {
  const now = new Date();
  const timestamp = now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  const logPath = path.join(LOG_DIR, logFile);
  const logTail = readLastLines(logPath, 80);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsedPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const memUsedGB = ((totalMem - freeMem) / 1073741824).toFixed(1);
  const memTotalGB = (totalMem / 1073741824).toFixed(1);
  const cpuCores = os.cpus().length;

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

  const profiles = readJson(PROFILES_FILE) || {};
  const skillProfile = profiles[skill];

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

  const cooldowns = readJson(path.join(PIPELINE, 'cooldowns.json')) || {};
  const cooldownKey = `${skill}:${issue}`;
  const cooldownInfo = cooldowns[cooldownKey];

  const analysis = analyzeRejection(exitCode, elapsed, motivo, logTail, avgCpu, avgMem, skill);
  const issueCtx = fetchIssueContext(issue);
  const rejectHistory = getRejectHistory(issue);
  const otherGates = getGateStatus(issue);
  const rootCause = classifyRootCause(motivo, logTail, exitCode);
  const readableLog = extractMeaningfulLog(logTail, 30);
  const depIssues = fetchDependencyIssues(issue);

  return {
    // Identifiers
    issue, skill, fase, exitCode, elapsed, motivo, pipeline, logFile,
    timestamp, isoDate: now.toISOString().slice(0, 10),
    // System
    memUsedPct, memUsedGB, memTotalGB, cpuCores,
    avgCpu, avgMem, avgAgents, pressureLevels, recentMetrics,
    // Skill
    skillProfile, yamlData, cooldownInfo,
    // Analysis
    analysis, issueCtx, rejectHistory, otherGates, rootCause,
    // Logs
    logTail, readableLog,
    // Dependencies
    depIssues,
    // Auto-created deps (filled in phase 1 direct or phase 2)
    autoCreatedDeps: [],
    // Existing deps found during dedup (filled in phase 1)
    existingDeps: [],
  };
}

// =============================================================================
// renderHtml(data) — genera el HTML del reporte a partir de los datos
// =============================================================================
function renderHtml(data) {
  const {
    issue, skill, fase, exitCode, elapsed, motivo, pipeline, timestamp, isoDate,
    memUsedPct, memUsedGB, memTotalGB, cpuCores,
    avgCpu, avgMem, avgAgents, pressureLevels, recentMetrics,
    skillProfile, yamlData, cooldownInfo,
    analysis, issueCtx, rejectHistory, otherGates, rootCause,
    logTail, readableLog, depIssues, autoCreatedDeps,
  } = data;

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
  .context-box { background: #eaf2f8; border-left: 4px solid #2980b9; padding: 14px; margin: 12px 0; border-radius: 0 6px 6px 0; }
  .rootcause-box { background: #fdedec; border-left: 4px solid #e74c3c; padding: 14px; margin: 12px 0; border-radius: 0 6px 6px 0; }
  .history-box { background: #f5eef8; border-left: 4px solid #8e44ad; padding: 14px; margin: 12px 0; border-radius: 0 6px 6px 0; }
  .gate-approved { color: #27ae60; font-weight: 600; }
  .gate-rejected { color: #c0392b; font-weight: 600; }
  .label-tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.8em; background: #ecf0f1; color: #2c3e50; margin: 1px; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 0.8em; color: #999; text-align: center; }
</style>
</head><body>

<h1>Reporte de Rechazo &mdash; #${escapeHtml(issue)} ${escapeHtml(skill)}</h1>
<p><span class="badge badge-red">RECHAZADO</span> &nbsp; ${escapeHtml(timestamp)}</p>

<h2>Que se estaba haciendo</h2>
<div class="context-box">
  <h3>${escapeHtml(issueCtx.title)}</h3>
  <p>${escapeHtml(issueCtx.summary)}</p>
  ${issueCtx.labels.length > 0 ? '<p>' + issueCtx.labels.map(l => '<span class="label-tag">' + escapeHtml(l) + '</span>').join(' ') + '</p>' : ''}
</div>

<h2>Que paso (en lenguaje simple)</h2>
<div class="rootcause-box">
  <h3>${escapeHtml(rootCause.emoji)} ${escapeHtml(rootCause.negocio || rootCause.desc)}</h3>
  <p><span class="badge ${rootCause.origen === 'EXTERNO' ? 'badge-yellow' : rootCause.origen === 'INTERNO' ? 'badge-red' : 'badge-blue'}">${escapeHtml(rootCause.origen || 'INDETERMINADO')}: ${rootCause.origen === 'EXTERNO' ? 'No es culpa de este issue' : rootCause.origen === 'INTERNO' ? 'Problema en el codigo de este issue' : 'Requiere revision'}</span></p>
</div>

<h2>Sintoma vs Causa Raiz</h2>
<table>
  <tr><th>Sintoma (lo que se vio)</th><td>${escapeHtml(motivo)}</td></tr>
  <tr><th>Causa raiz (lo que realmente paso)</th><td>${escapeHtml(rootCause.desc)}</td></tr>
  <tr><th>Clasificacion</th><td><span class="badge ${rootCause.tipo === 'INFRAESTRUCTURA' || rootCause.tipo === 'DEPENDENCIA' ? 'badge-yellow' : 'badge-red'}">${escapeHtml(rootCause.tipo)}</span></td></tr>
  <tr><th>Origen</th><td>${rootCause.origen === 'EXTERNO' ? '⚠️ El problema NO esta en el codigo de este issue — es un factor externo (infra, dependencia de otro feature, bug en otra pantalla)' : rootCause.origen === 'INTERNO' ? '🔴 El problema esta en los cambios de este issue — requiere correccion del desarrollador' : '❓ No se pudo determinar automaticamente'}</td></tr>
</table>

${otherGates.length > 0 ? `
<h2>Estado de los Otros Gates</h2>
<table>
  <tr><th>Gate</th><th>Resultado</th><th>Detalle</th></tr>
  ${otherGates.map(g => {
    const cls = g.resultado === 'aprobado' ? 'gate-approved' : g.resultado === 'rechazado' ? 'gate-rejected' : '';
    const icon = g.resultado === 'aprobado' ? '✅' : g.resultado === 'rechazado' ? '❌' : '⏳';
    return '<tr><td>' + escapeHtml(g.skill) + '</td><td class="' + cls + '">' + icon + ' ' + escapeHtml(g.resultado) + '</td><td>' + escapeHtml(g.motivo ? g.motivo.substring(0, 120) : '-') + '</td></tr>';
  }).join('')}
</table>` : ''}

${rejectHistory.length > 1 ? `
<h2>Historial de Rechazos (este issue)</h2>
<div class="history-box">
  <p>Este issue ha sido rechazado <strong>${rejectHistory.length} veces</strong>:</p>
  <table>
    <tr><th>Agente</th><th>Fase</th><th>Rechazado por</th><th>Motivo resumido</th></tr>
    ${rejectHistory.map(h => '<tr><td>' + escapeHtml(h.skill) + '</td><td>' + escapeHtml(h.fase) + '</td><td>' + escapeHtml(h.rechazadoPor) + '</td><td>' + escapeHtml((h.motivo || '').substring(0, 100)) + '</td></tr>').join('')}
  </table>
</div>` : ''}

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

<h2>Que hay que hacer para desbloquearlo</h2>
<div class="solution-box">
  <h3>${rootCause.origen === 'EXTERNO' ? '⚠️ Este issue NO necesita cambios — el bloqueo es externo' : '🔧 Acciones requeridas en este issue'}</h3>
  <p>${escapeHtml(analysis.suggestion)}</p>
  ${analysis.steps.length > 0 ? '<h3>Pasos concretos</h3><ol>' + analysis.steps.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ol>' : ''}
  ${autoCreatedDeps.length > 0 ? '<h3>Issues de Dependencia Creados Automaticamente</h3><table><tr><th>Issue</th><th>Titulo</th><th>Estado</th></tr>' + autoCreatedDeps.map(d => '<tr><td><strong>#' + (d.number || '?') + '</strong></td><td>' + escapeHtml(d.title) + '</td><td>' + (d.failed ? '<span class="badge badge-red">Fallo al crear</span>' : d.alreadyExisted ? '<span class="badge badge-yellow">Ya existia</span>' : '<span class="badge badge-blue">Creado ahora</span>') + '</td></tr>').join('') + '</table><p><em>Este issue queda bloqueado (blocked:dependencies) hasta que se resuelvan estos issues.</em></p>' : ''}
  ${analysis.externalDeps && analysis.externalDeps.length > 0 && autoCreatedDeps.length === 0 ? '<h3>Dependencias externas detectadas</h3><ul>' + analysis.externalDeps.map(d => '<li>🔗 ' + escapeHtml(d) + '</li>').join('') + '</ul><p><em>No se pudieron crear issues automaticamente. Crear manualmente antes de reintentar.</em></p>' : ''}
</div>

${(depIssues.linkedDeps.length > 0 || depIssues.isBlocked) && autoCreatedDeps.length === 0 ? `
<h2>Issues de Dependencia Previos</h2>
<div class="${depIssues.isBlocked ? 'rootcause-box' : 'history-box'}">
  ${depIssues.isBlocked ? '<p>⛔ <strong>Este issue esta BLOQUEADO</strong> — tiene label <span class="badge badge-red">blocked:dependencies</span>. No se puede avanzar hasta que se resuelvan las dependencias listadas abajo.</p>' : ''}
  ${depIssues.linkedDeps.length > 0 ? `
  <p>Issues de dependencia vinculados previamente:</p>
  <table>
    <tr><th>Issue</th><th>Titulo</th><th>Estado</th></tr>
    ${depIssues.linkedDeps.map(d => {
      const stateIcon = d.state === 'OPEN' ? '🔴 Pendiente' : d.state === 'CLOSED' ? '✅ Resuelto' : d.state;
      const stateCls = d.state === 'CLOSED' ? 'gate-approved' : 'gate-rejected';
      return '<tr><td><strong>#' + d.number + '</strong></td><td>' + escapeHtml(d.title) + '</td><td class="' + stateCls + '">' + stateIcon + '</td></tr>';
    }).join('')}
  </table>
  <p><em>${depIssues.linkedDeps.filter(d => d.state === 'OPEN').length > 0 ? '⚠️ Hay dependencias pendientes de resolver. Este issue no debe reintentarse hasta que se cierren.' : '✅ Todas las dependencias estan resueltas. Se puede reintentar la validacion.'}</em></p>` : '<p>El issue esta marcado como bloqueado pero no se encontraron issues de dependencia vinculados.</p>'}
</div>` : ''}

<h2>Log del Agente (resumen legible)</h2>
<pre><code>${escapeHtml(readableLog)}</code></pre>

<details><summary>Log crudo (ultimas 80 lineas)</summary>
<pre><code>${escapeHtml(logTail)}</code></pre>
</details>

<div class="footer">
  Intrale Platform &mdash; Reporte de Rechazo &mdash; v5.0 &mdash; ${escapeHtml(isoDate)}
</div>
</body></html>`;
}

// =============================================================================
// generateNarration(data) — narración en texto plano para TTS
// =============================================================================
function generateNarration(data) {
  const {
    issue, skill, fase, motivo,
    issueCtx, rootCause, analysis, rejectHistory, depIssues, autoCreatedDeps,
  } = data;

  const parts = [];

  parts.push(`Reporte de rechazo del issue número ${issue}, que estaba en la fase de ${fase} con el agente ${skill}.`);
  parts.push(`El issue se llama "${issueCtx.title}". ${issueCtx.summary}`);
  parts.push(`¿Qué pasó? ${rootCause.negocio || rootCause.desc}`);

  const origenTexto = rootCause.origen === 'EXTERNO'
    ? 'El problema es externo, no es culpa de este issue.'
    : rootCause.origen === 'INTERNO'
    ? 'El problema está en los cambios de este issue, requiere corrección del desarrollador.'
    : 'No se pudo determinar automáticamente si es un problema interno o externo.';
  parts.push(`Causa raíz: ${rootCause.desc}. Clasificación: ${rootCause.tipo}. ${origenTexto}`);

  if (rejectHistory.length > 1) {
    parts.push(`Este issue ya fue rechazado ${rejectHistory.length} veces. Los rechazos anteriores fueron por: ${rejectHistory.map(h => h.skill + ' en fase ' + h.fase).join(', ')}.`);
  }

  parts.push(`Análisis de la situación: ${analysis.conclusion}`);
  if (analysis.factors.length > 0) {
    parts.push(`Factores que contribuyeron: ${analysis.factors.join('. ')}.`);
  }
  parts.push(`Para desbloquearlo: ${analysis.suggestion}`);
  if (analysis.steps.length > 0) {
    parts.push(`Pasos concretos: ${analysis.steps.map((s, i) => (i + 1) + ', ' + s).join('. ')}.`);
  }

  if (autoCreatedDeps && autoCreatedDeps.length > 0) {
    const newOnes = autoCreatedDeps.filter(d => !d.alreadyExisted && !d.failed);
    const existingOnes = autoCreatedDeps.filter(d => d.alreadyExisted);
    const failedOnes = autoCreatedDeps.filter(d => d.failed);
    if (newOnes.length > 0) {
      parts.push(`Se crearon automáticamente ${newOnes.length} issues de dependencia: ${newOnes.map(d => 'número ' + d.number + ', ' + d.title.replace(/^dep:\s*/i, '')).join('. ')}.`);
    }
    if (existingOnes.length > 0) {
      parts.push(`Se vincularon ${existingOnes.length} issues de dependencia que ya existían: ${existingOnes.map(d => 'número ' + d.number).join(', ')}.`);
    }
    if (failedOnes.length > 0) {
      parts.push(`No se pudieron crear ${failedOnes.length} issues de dependencia por errores técnicos.`);
    }
    parts.push(`El issue queda bloqueado hasta que se resuelvan estas dependencias.`);
  } else if (depIssues.isBlocked || depIssues.linkedDeps.length > 0) {
    const openDeps = depIssues.linkedDeps.filter(d => d.state === 'OPEN');
    const closedDeps = depIssues.linkedDeps.filter(d => d.state === 'CLOSED');
    parts.push(`Este issue está bloqueado por dependencias.`);
    if (depIssues.linkedDeps.length > 0) {
      parts.push(`Hay ${depIssues.linkedDeps.length} issues de dependencia vinculados: ${depIssues.linkedDeps.map(d => 'número ' + d.number + ', ' + d.title + ', estado ' + (d.state === 'OPEN' ? 'pendiente' : 'resuelto')).join('. ')}.`);
    }
    if (openDeps.length > 0) {
      parts.push(`Hay ${openDeps.length} dependencias pendientes de resolver. No se debe reintentar hasta que se cierren.`);
    } else if (closedDeps.length > 0) {
      parts.push(`Todas las dependencias están resueltas. Se puede reintentar la validación.`);
    }
  }

  return parts.join(' ');
}

// =============================================================================
// sendReport(data) — genera PDF + audio y envía a Telegram
// =============================================================================
async function sendReport(data) {
  const html = renderHtml(data);

  const htmlPath = path.join(LOG_DIR, `rejection-${data.issue}-${data.skill}.html`);
  fs.writeFileSync(htmlPath, html);

  execSync(`node "${REPORT_SCRIPT}" "${htmlPath}" "Rechazo #${data.issue} ${data.skill} (${data.fase})"`, {
    cwd: ROOT, stdio: 'inherit', timeout: 120000
  });

  const pdfName = `rejection-${data.issue}-${data.skill}.pdf`;
  const pdfDest = path.join(LOG_DIR, pdfName);
  const possiblePdfPaths = [
    htmlPath.replace(/\.html$/, '.pdf'),
    path.join(ROOT, 'docs', 'qa', pdfName),
  ];
  for (const src of possiblePdfPaths) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, pdfDest);
      console.log(`[rejection-report] PDF copiado a ${pdfDest}`);
      if (src !== pdfDest) try { fs.unlinkSync(src); } catch {}
      break;
    }
  }

  try { fs.unlinkSync(htmlPath); } catch {}
  try { fs.unlinkSync(path.join(ROOT, 'docs', 'qa', `rejection-${data.issue}-${data.skill}.html`)); } catch {}

  console.log(`[rejection-report] Reporte enviado a Telegram para #${data.issue} ${data.skill}`);

  // Audio TTS
  try {
    const { textToSpeech, sendVoiceTelegram } = require('./multimedia');
    const TG_CONFIG = path.join(ROOT, '.claude', 'hooks', 'telegram-config.json');
    const tgConfig = JSON.parse(fs.readFileSync(TG_CONFIG, 'utf8'));

    const narration = generateNarration(data);
    console.log(`[rejection-report] Generando audio TTS (${narration.length} chars)...`);

    const MAX_TTS_CHARS = 3800;
    const chunks = [];
    if (narration.length <= MAX_TTS_CHARS) {
      chunks.push(narration);
    } else {
      const sentences = narration.split(/(?<=[.!?])\s+/);
      let current = '';
      for (const sentence of sentences) {
        if ((current + ' ' + sentence).length > MAX_TTS_CHARS && current.length > 0) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current = current ? current + ' ' + sentence : sentence;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks.length > 1
        ? `Parte ${i + 1} de ${chunks.length}. ${chunks[i]}`
        : chunks[i];
      const audioBuffer = await textToSpeech(chunkText);
      if (audioBuffer) {
        const sent = await sendVoiceTelegram(audioBuffer, tgConfig.bot_token, tgConfig.chat_id);
        console.log(`[rejection-report] Audio ${i + 1}/${chunks.length} enviado: ${sent ? 'OK' : 'FALLO'}`);
      } else {
        console.log(`[rejection-report] No se pudo generar audio TTS (chunk ${i + 1})`);
      }
    }
  } catch (audioErr) {
    console.error(`[rejection-report] Error generando audio TTS (no fatal): ${audioErr.message}`);
  }
}

// =============================================================================
// enqueueGitHub(data) — encola un item en servicio-github
// =============================================================================
function enqueueGitHub(data) {
  const filename = `${data.group || 'ungrouped'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filepath = path.join(GH_QUEUE_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`[rejection-report] Encolado: ${data.action} → ${filename}`);
  return filename;
}

// =============================================================================
// Dedup: buscar si ya existe un issue de dependencia abierto
// =============================================================================
function findExistingDepIssue(depText) {
  try {
    const ghPath = fs.existsSync(GH_CLI) ? GH_CLI : 'gh';
    const searchQuery = depText.length > 60 ? depText.substring(0, 60) : depText;
    const searchRaw = execSync(
      `"${ghPath}" issue list --label "qa:dependency" --search "${searchQuery.replace(/"/g, '\\"')}" --json number,title,state --repo intrale/platform --limit 5`,
      { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const existing = JSON.parse(searchRaw || '[]');
    return existing.find(e => e.state === 'OPEN') || null;
  } catch {
    return null;
  }
}

// =============================================================================
// FASE 1 (collect) — entry point original
// =============================================================================
async function phaseCollect() {
  console.log(`[rejection-report] Fase 1 (collect) para #${issue} ${skill} (${fase})...`);
  const data = collectReportData();

  const externalDeps = data.analysis.externalDeps;

  // Sin dependencias externas → fast path: generar PDF directo
  if (!externalDeps || externalDeps.length === 0) {
    console.log(`[rejection-report] Sin dependencias externas — generando PDF directo`);
    await sendReport(data);
    return;
  }

  // Hay dependencias externas — dedup contra GitHub
  console.log(`[rejection-report] ${externalDeps.length} dependencias externas detectadas — verificando duplicados...`);
  const existingDeps = [];
  const newDeps = [];

  for (const dep of externalDeps) {
    const existing = findExistingDepIssue(dep);
    if (existing) {
      existingDeps.push({ number: existing.number, title: existing.title, state: 'OPEN', alreadyExisted: true });
      console.log(`[rejection-report] Dependencia ya existe: #${existing.number} — ${existing.title}`);
    } else {
      newDeps.push(dep);
    }
  }

  // Si todas las dependencias ya existen → no encolar nada, generar PDF directo
  if (newDeps.length === 0) {
    console.log(`[rejection-report] Todas las dependencias ya existen — generando PDF directo`);
    data.autoCreatedDeps = existingDeps;
    await sendReport(data);
    // Encolar comment + label (el issue puede no estar bloqueado todavía)
    enqueueCommentAndLabel(data.issue, existingDeps, data.issueCtx.title);
    return;
  }

  // Hay nuevas dependencias — persistir contexto y encolar creación
  console.log(`[rejection-report] ${newDeps.length} nuevas dependencias a crear — encolando en servicio-github...`);

  // Determinar path del worktree para persistir el contexto
  const worktreePath = path.join(ROOT, '..', `platform.agent-${issue}-${skill}`);
  const contextDir = fs.existsSync(worktreePath) ? worktreePath : LOG_DIR;
  const contextPath = path.join(contextDir, `.rejection-context-${issue}-${skill}.json`);

  // Guardar existingDeps en el contexto para mergear en fase 2
  data.existingDeps = existingDeps;
  fs.writeFileSync(contextPath, JSON.stringify(data, null, 2));
  console.log(`[rejection-report] Contexto persistido en ${contextPath}`);

  // Encolar create-issue para cada dependencia nueva
  const group = `rejection-${issue}-${Date.now()}`;
  const issueTitle = data.issueCtx.title || '';

  for (const dep of newDeps) {
    const depTitle = `dep: ${dep.length > 80 ? dep.substring(0, 80) + '...' : dep}`;
    const depBody = [
      '## Contexto',
      '',
      `Dependencia detectada automáticamente durante el rechazo del issue #${issue} (${issueTitle}).`,
      '',
      '## Problema',
      '',
      dep,
      '',
      '## Origen',
      '',
      `El issue #${issue} fue rechazado porque depende de una funcionalidad que no existe o tiene un bug que bloquea la ejecución.`,
      '',
      '## Criterios de aceptación',
      '',
      '- [ ] La funcionalidad descrita arriba está implementada y funcionando',
      `- [ ] El issue #${issue} puede reintentarse sin este bloqueo`,
      '',
      '---',
      `_Issue creado automáticamente por el rejection report del pipeline._`,
    ].join('\n');

    enqueueGitHub({
      action: 'create-issue',
      title: depTitle,
      body: depBody,
      labels: 'needs-definition,qa:dependency',
      repo: 'intrale/platform',
      group,
      groupSize: newDeps.length,
      onComplete: {
        command: `node .pipeline/rejection-report.js --phase complete --context "${contextPath}"`
      }
    });
  }

  console.log(`[rejection-report] ${newDeps.length} items encolados en grupo "${group}" — el PDF se generará cuando se completen`);
}

// =============================================================================
// FASE 2 (complete) — invocada por onComplete del condensador
// =============================================================================
async function phaseComplete() {
  console.log(`[rejection-report] Fase 2 (complete) — leyendo contexto y resultados...`);

  // Leer contexto
  if (!contextFile || !fs.existsSync(contextFile)) {
    console.error(`[rejection-report] Contexto no encontrado: ${contextFile} — posiblemente el worktree fue limpiado`);
    process.exit(0);
  }

  const data = readJson(contextFile);
  if (!data) {
    console.error(`[rejection-report] Error leyendo contexto: ${contextFile}`);
    process.exit(0);
  }

  // Leer resultados del condensador
  let results = [];
  if (resultsFile && fs.existsSync(resultsFile)) {
    results = readJson(resultsFile) || [];
  } else {
    console.error(`[rejection-report] Results no encontrado: ${resultsFile}`);
  }

  // Mergear: existingDeps + resultados del condensador
  const autoCreatedDeps = [...(data.existingDeps || [])];

  for (const item of results) {
    if (item._status === 'failed') {
      autoCreatedDeps.push({
        number: null,
        title: item.title || '(desconocido)',
        failed: true,
        error: item.lastError || 'Error desconocido',
        alreadyExisted: false,
      });
    } else if (item.result && item.result.number) {
      autoCreatedDeps.push({
        number: item.result.number,
        title: item.title || '(desconocido)',
        state: 'OPEN',
        alreadyExisted: false,
      });
    }
  }

  data.autoCreatedDeps = autoCreatedDeps;
  console.log(`[rejection-report] ${autoCreatedDeps.length} dependencias totales (${autoCreatedDeps.filter(d => d.failed).length} fallidas)`);

  // Generar PDF + audio
  await sendReport(data);

  // Encolar comment + label en servicio-github
  const successDeps = autoCreatedDeps.filter(d => !d.failed);
  if (successDeps.length > 0) {
    enqueueCommentAndLabel(data.issue, successDeps, data.issueCtx.title);
  }

  // Cleanup
  try { fs.unlinkSync(contextFile); } catch {}
  try { if (resultsFile) fs.unlinkSync(resultsFile); } catch {}
  console.log(`[rejection-report] Fase 2 completada para #${data.issue}`);
}

// =============================================================================
// Encolar comment + label blocked:dependencies
// =============================================================================
function enqueueCommentAndLabel(issueNum, deps, issueTitle) {
  const newIssues = deps.filter(c => !c.alreadyExisted);
  const existingIssues = deps.filter(c => c.alreadyExisted);
  const commentParts = ['## 🔗 Dependencias detectadas por el pipeline\n'];
  if (newIssues.length > 0) {
    commentParts.push('**Issues creados automáticamente:**');
    for (const c of newIssues) commentParts.push(`- #${c.number} — ${c.title}`);
  }
  if (existingIssues.length > 0) {
    commentParts.push('\n**Issues existentes vinculados:**');
    for (const c of existingIssues) commentParts.push(`- #${c.number} — ${c.title}`);
  }
  commentParts.push(`\nEste issue queda bloqueado hasta que se resuelvan las dependencias listadas.`);

  enqueueGitHub({
    action: 'comment',
    issue: parseInt(issueNum),
    body: commentParts.join('\n'),
  });

  enqueueGitHub({
    action: 'label',
    issue: parseInt(issueNum),
    label: 'blocked:dependencies',
  });

  console.log(`[rejection-report] Comment + label blocked:dependencies encolados para #${issueNum}`);
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  try {
    if (phase === 'complete') {
      await phaseComplete();
    } else {
      await phaseCollect();
    }
  } catch (e) {
    console.error(`[rejection-report] Error: ${e.stack || e.message}`);
    process.exit(1);
  }
}

main();
