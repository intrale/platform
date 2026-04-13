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
    return { title: `Issue #${issueNum}`, labels: [], summary: '(GitHub no respondio a tiempo — el issue existe pero no se pudo leer su contenido)' };
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

  // --- Fallback inteligente: extraer info del log en vez de decir "desconocido" ---
  // Buscar el último mensaje del agente con contenido diagnóstico
  const parsed = parseLogErrors(logTail);
  const lastDiag = parsed.agentMessages.filter(m => m.length > 30).slice(-3);
  const lastErrors = parsed.toolErrors.slice(-3);

  if (lastErrors.length > 0) {
    const errorSnippet = lastErrors[0].substring(0, 150).replace(/\n/g, ' ');
    return { tipo: 'ERROR-DETECTADO', emoji: '⚠️', origen: 'REQUIERE-REVISION',
      desc: `El agente fallo con errores en la ejecucion. Ultimo error: ${errorSnippet}`,
      negocio: `Hubo errores durante la ejecucion. El ultimo error detectado fue: "${errorSnippet}". Revisar el log para mas contexto.` };
  }

  if (lastDiag.length > 0) {
    const diagSnippet = lastDiag[lastDiag.length - 1].substring(0, 150).replace(/\n/g, ' ');
    return { tipo: 'AGENTE-REPORTO', emoji: '📋', origen: 'REQUIERE-REVISION',
      desc: `El agente reporto: ${diagSnippet}`,
      negocio: `El agente dejo un diagnostico antes de terminar: "${diagSnippet}". Revisar el log para entender el contexto completo.` };
  }

  // Fallback absoluto — pero con info útil del motivo
  const motivoClean = (motivo || '').substring(0, 150);
  return { tipo: 'SIN-DIAGNOSTICO', emoji: '📭', origen: 'REQUIERE-REVISION',
    desc: `El agente termino sin dejar un diagnostico claro. Motivo registrado: "${motivoClean}"`,
    negocio: `El agente finalizo sin reportar la causa. El motivo registrado es: "${motivoClean}". El log puede tener mas detalles.` };
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

// --- Parsear log JSONL y extraer errores/mensajes significativos ---
function parseLogErrors(logTail) {
  if (!logTail) return { errors: [], agentMessages: [], toolErrors: [] };
  const errors = [];
  const agentMessages = [];
  const toolErrors = [];
  const lines = logTail.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // Extraer mensajes de texto del agente (diagnósticos, conclusiones)
    if (obj.type === 'assistant' && obj.message && obj.message.content) {
      for (const c of obj.message.content) {
        if (c.type === 'text' && c.text && c.text.length > 20) {
          agentMessages.push(c.text);
        }
      }
    }

    // Extraer resultados de herramientas con errores
    if (obj.tool_use_result) {
      const stdout = obj.tool_use_result.stdout || '';
      const stderr = obj.tool_use_result.stderr || '';
      const combined = stdout + '\n' + stderr;
      if (combined.match(/error|FAILED|Exception|crash|fatal|SIGSEGV|ANR|timeout|refused|denied/i)) {
        toolErrors.push(combined.substring(0, 500));
      }
    }

    // Extraer tool_result content directamente (formato alternativo)
    if (obj.type === 'user' && obj.message && obj.message.content) {
      for (const c of obj.message.content) {
        if (c.type === 'tool_result' && typeof c.content === 'string') {
          if (c.content.match(/error|FAILED|Exception|crash|fatal|SIGSEGV|ANR|timeout|refused|denied/i)) {
            toolErrors.push(c.content.substring(0, 500));
          }
        }
      }
    }
  }

  return { errors, agentMessages, toolErrors };
}

// --- Detectar dependencias externas en el log ---
// Retorna array de objetos: { summary, detail, source }
function detectExternalDependencies(logTail, motivo) {
  const deps = [];
  const seen = new Set();  // dedup por key normalizado
  const logLower = (logTail || '').toLowerCase();
  const motivoLower = (motivo || '').toLowerCase();
  const combined = logLower + ' ' + motivoLower;

  function addDep(summary, detail, source, priority) {
    // Normalizar key para dedup — quitar artículos, preposiciones y signos
    const key = summary.toLowerCase().replace(/\s+/g, ' ')
      .replace(/\b(el|la|los|las|un|una|de|del|en|que|con|por|al|se|no|es)\b/g, '')
      .replace(/[—\-:()]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    // Extraer palabras clave significativas del summary para fuzzy dedup
    const keyWords = key.split(' ').filter(w => w.length > 3);
    // Verificar si ya hay una dep similar
    for (const existingKey of seen) {
      // Exact substring match
      if (existingKey.includes(key) || key.includes(existingKey)) return;
      // Fuzzy: si comparten 2+ palabras significativas, es un duplicado
      const existingWords = existingKey.split(' ').filter(w => w.length > 3);
      const shared = keyWords.filter(w => existingWords.some(ew => ew.includes(w) || w.includes(ew)));
      if (shared.length >= 2 && shared.length >= Math.min(keyWords.length, existingWords.length) * 0.5) return;
    }
    seen.add(key);
    deps.push({
      summary,
      detail: detail || summary,
      source: source || 'log-analysis',
      priority: priority || 'normal'  // 'high' = bloqueante directo, 'normal' = contribuyente
    });
  }

  // --- 1. Análisis profundo del log JSONL ---
  const parsed = parseLogErrors(logTail);

  // Buscar en mensajes del agente: conclusiones explícitas sobre bloqueos
  for (const msg of parsed.agentMessages) {
    const msgLower = msg.toLowerCase();

    // Agente dice que hay un bug/crash/error en algo específico
    // Matchea "crash en Dashboard", "error en ClientSearchBusinessesService", "bug en la pantalla de login", etc.
    // Requiere que el target empiece con mayúscula O sea una palabra compuesta con sufijo conocido
    const crashInOther = msg.match(/(?:crash(?:e[oó])?|error|falla(?:ndo)?|bug|excepci[oó]n|exception)\s+(?:en|in|de|del)\s+(?:el|la|otra?|un|una)?\s*([A-Z][\w]{3,}(?:\s+(?:de\s+)?[A-Z][\w]+){0,2})/);
    if (crashInOther && !msgLower.includes('este issue') && !msgLower.includes('mi codigo') && !msgLower.includes('mi código')) {
      const target = crashInOther[1].trim();
      // Solo si el target es un nombre de componente (no una palabra genérica)
      if (target.length > 4 && !target.match(/^(?:Error|Problema|Fallo|Bug|Issue|Codigo|Código|Otro|Esta|Este)$/i)) {
        addDep(
          `Bug en ${target} bloquea la ejecucion del feature`,
          `El agente reporto: "${msg.substring(0, 300)}"`,
          'agent-diagnostic',
          'high'
        );
      }
    }

    // Agente reporta error de deserialización/parsing JSON (variantes amplias)
    if (msgLower.match(/(?:deseriali|parsing|json|parsear|serializ)\w*\s+(?:error|falla|excep|crash|problem)/i) ||
        msgLower.match(/(?:error|falla|excep|crash|problem)\w*\s+(?:de\s+)?(?:deseriali|parsing|json|parsear|serializ)/i)) {
      // Intentar extraer el servicio/clase afectado
      const svcMatch = msg.match(/(Client\w+|Do\w+|Comm\w+|\w+Service|\w+ViewModel)/);
      const svc = svcMatch ? svcMatch[1] : '';
      addDep(
        `Error de deserializacion JSON${svc ? ` en ${svc}` : ''} — respuesta del backend incompatible`,
        `El agente reporto: "${msg.substring(0, 300)}"`,
        'agent-diagnostic',
        'high'
      );
    }

    // Agente dice que depende de / está bloqueado por un issue #
    const depIssueMatch = msg.match(/(?:depende\s+de|bloqueado?\s+por|requiere\s+que\s+se\s+resuelva)\s+(?:el\s+)?#(\d+)/i);
    if (depIssueMatch) {
      addDep(
        `Depende de issue #${depIssueMatch[1]}`,
        `El agente identifico una dependencia explicita: "${msg.substring(0, 300)}"`,
        'agent-explicit',
        'high'
      );
    }

    // Agente dice que necesita/requiere/depende de algo (feature, corrección, etc.)
    const depFeatureMatch = msg.match(/(?:necesita|requiere|depende\s+de|falta)\s+(?:que\s+)?(?:se\s+)?(?:implemente|corrija|arregle|construya|resuelva|cree|configure)\s+([\w\s]{5,80}?)(?:\.|,|;|$)/i);
    if (depFeatureMatch) {
      const feat = depFeatureMatch[1].trim();
      if (feat.length > 5 && !feat.match(/^(?:el|la|un|una|los|las|este|esta|cambios?|esto|eso)$/i)) {
        addDep(
          `Requiere: ${feat.substring(0, 80)}`,
          `El agente identifico una necesidad: "${msg.substring(0, 300)}"`,
          'agent-explicit',
          'high'
        );
      }
    }

    // Agente dice que una pantalla/screen/ruta no existe, no funciona, falta
    const missingScreen = msg.match(/(?:pantalla|screen|ruta|route|navegacion|vista|view)\s+(?:de\s+)?(\w[\w\s]{3,40}?)\s+(?:no\s+(?:existe|funciona|esta\s+implementad|responde|carga)|falta|no\s+se\s+encontr)/i);
    if (missingScreen) {
      addDep(
        `Pantalla o ruta faltante: ${missingScreen[1].trim()}`,
        `El agente reporto: "${msg.substring(0, 300)}"`,
        'agent-diagnostic',
        'high'
      );
    }

    // Agente reporta que no pudo hacer login / autenticación falla
    if (msgLower.match(/(?:no\s+(?:pud[oe]|logr[oe])\s+(?:hacer\s+)?login|login\s+fall[oó]|autenticaci[oó]n\s+fall[oó]|no\s+se\s+pudo\s+autenticar|credenciales?\s+(?:inv[aá]lid|rechazad|expirad))/i)) {
      addDep(
        'El login no funciona — no se puede acceder a la app para probar',
        `El agente reporto problema de auth: "${msg.substring(0, 300)}"`,
        'agent-diagnostic',
        'high'
      );
    }

    // Agente reporta que la app no inicia / no se instala / APK no funciona
    if (msgLower.match(/(?:app\s+no\s+(?:inicia|arranca|abre|carga|responde)|apk\s+no\s+(?:se\s+instal|funciona)|no\s+se\s+pudo\s+instalar|install.*fail)/i)) {
      addDep(
        'La app no se puede instalar o no inicia correctamente',
        `El agente reporto: "${msg.substring(0, 300)}"`,
        'agent-diagnostic',
        'high'
      );
    }

    // Agente dice que el backend no responde / API timeout / servicio caído
    if (msgLower.match(/(?:backend|servidor|api|servicio)\s+(?:no\s+(?:responde|funciona|está\s+disponible)|ca[ií]do|timeout|down)/i) ||
        msgLower.match(/(?:no\s+(?:responde|funciona|está\s+disponible))\s+(?:el\s+)?(?:backend|servidor|api|servicio)/i)) {
      addDep(
        'El backend o API no responde — servicio posiblemente caido',
        `El agente reporto: "${msg.substring(0, 300)}"`,
        'agent-diagnostic',
        'normal'
      );
    }
  }

  // --- 2. Errores en tool results (compilación, runtime, API) ---
  for (const err of parsed.toolErrors) {
    const errLower = err.toLowerCase();

    // JSON parsing errors (app crashea por campos desconocidos del backend)
    if (errLower.match(/jsondecodingexception|unknownkeyexception|serializationexception|unexpected\s*json|unexpected\s*(?:field|key|token)|polymorphic\s*serializer/i)) {
      const serviceMatch = err.match(/(Client\w+Service|Client\w+|Do\w+|Comm\w+)/);
      const fieldMatch = err.match(/(?:key|field|property|element)\s*[=:]\s*['"]?(\w+)/i);
      const classMatch = err.match(/class\s+'?([\w.]+)/);
      const svc = serviceMatch ? serviceMatch[1] : (classMatch ? classMatch[1].split('.').pop() : 'un servicio client');
      const field = fieldMatch ? ` (campo: ${fieldMatch[1]})` : '';
      addDep(
        `Error JSON en ${svc}${field} — el backend devuelve datos que la app no puede parsear`,
        `La app crashea al parsear la respuesta del backend. Posible campo nuevo o tipo incompatible. Error: "${err.substring(0, 400)}"`,
        'tool-error',
        'high'
      );
    }

    // Unresolved reference en otro módulo (compilación rompe por dependencia)
    if (errLower.includes('unresolved reference') && !errLower.includes(issue)) {
      const refMatch = err.match(/unresolved reference[:\s]+['"]?(\w+)/i);
      const fileMatch = err.match(/(?:e:\s*|file:\s*)([\w/\\]+\.kt)/);
      if (refMatch) {
        addDep(
          `Referencia no resuelta: ${refMatch[1]}${fileMatch ? ` en ${path.basename(fileMatch[1])}` : ''}`,
          `Error de compilacion: se usa una funcion/clase/variable que no existe o no esta importada. Error: "${err.substring(0, 400)}"`,
          'tool-error',
          'high'
        );
      }
    }

    // Kotlin compilation errors (type mismatch, overload resolution, etc.)
    if (errLower.match(/type\s*mismatch|overload\s*resolution\s*ambiguity|none\s*of\s*the\s*following|cannot\s*access/i) && !errLower.includes(issue)) {
      const fileMatch = err.match(/(?:e:\s*|file:\s*)([\w/\\]+\.kt):?(\d+)?/);
      const desc = err.match(/(?:type mismatch|overload resolution|none of the following|cannot access)[^.]{0,100}/i);
      addDep(
        `Error de compilacion${fileMatch ? ` en ${path.basename(fileMatch[1])}` : ''}: ${desc ? desc[0].substring(0, 80) : 'tipo incompatible'}`,
        `Error de tipos en el codigo: "${err.substring(0, 400)}"`,
        'tool-error',
        'high'
      );
    }

    // HTTP errors from API calls (4xx/5xx)
    if (errLower.match(/(?:status|http|response)\s*(?:code)?\s*[:=]\s*(?:4\d{2}|5\d{2})/)) {
      const statusMatch = err.match(/(?:status|http|response)\s*(?:code)?\s*[:=]\s*(4\d{2}|5\d{2})/i);
      const urlMatch = err.match(/(?:url|endpoint|path|ruta)\s*[:=]\s*['"]?([^\s'"]{5,})/i);
      if (statusMatch) {
        const code = statusMatch[1];
        const codeDesc = code.startsWith('4') ? 'error del cliente' : 'error del servidor';
        addDep(
          `Error HTTP ${code} (${codeDesc})${urlMatch ? ` en ${urlMatch[1]}` : ' en una API del backend'}`,
          `El backend respondio con error ${code}. Esto indica ${code === '401' || code === '403' ? 'un problema de autenticacion/permisos' : code === '404' ? 'que el endpoint no existe' : code === '500' ? 'un error interno del servidor' : 'un problema en la API'}. Error: "${err.substring(0, 400)}"`,
          'tool-error',
          code.startsWith('5') ? 'high' : 'normal'
        );
      }
    }

    // App crash / SIGSEGV / ANR
    if (errLower.match(/fatal\s*(?:signal|exception)|sigsegv|anr\s+in|application\s+not\s+responding/)) {
      const processMatch = err.match(/(?:process|pid)\s*[:=]\s*(\S+)/i);
      const causeMatch = err.match(/caused\s*by[:\s]+(\S[\S\s]{0,100})/i);
      addDep(
        `La app crasheo con error fatal${processMatch ? ` (proceso: ${processMatch[1]})` : ''}`,
        `Crash nativo detectado${causeMatch ? `. Causa: ${causeMatch[1].substring(0, 200)}` : ''}. Error: "${err.substring(0, 400)}"`,
        'tool-error',
        'high'
      );
    }

    // Stack trace con Caused by (captura la causa raíz de cualquier exception)
    if (errLower.includes('caused by') && !errLower.match(/jsondecodingexception|unknownkeyexception/)) {
      const causedBy = err.match(/caused\s*by[:\s]+([\w.]+(?:Exception|Error))[:\s]*(.*?)(?:\n|$)/i);
      if (causedBy) {
        const exType = causedBy[1].split('.').pop();
        const exMsg = (causedBy[2] || '').trim().substring(0, 100);
        // Solo agregar si es una exception que no matcheó arriba
        if (!seen.has(exType.toLowerCase())) {
          addDep(
            `Exception: ${exType}${exMsg ? ` — ${exMsg}` : ''}`,
            `Stack trace muestra: ${causedBy[0].substring(0, 400)}`,
            'tool-error',
            'normal'
          );
        }
      }
    }

    // ClassNotFoundException / NoSuchMethodError / NoClassDefFoundError
    if (errLower.match(/classnotfoundexception|nosuchmethoderror|noclassdeffounderror/)) {
      const classMatch = err.match(/(?:ClassNotFoundException|NoSuchMethodError|NoClassDefFoundError)[:\s]+(\S+)/);
      addDep(
        `Clase o metodo faltante: ${classMatch ? classMatch[1] : '(ver log)'}`,
        `Error de runtime: la app intenta usar una clase/metodo que no existe en esta version. Error: "${err.substring(0, 400)}"`,
        'tool-error',
        'high'
      );
    }

    // Navigation / route errors
    if (errLower.match(/navigation.*(?:error|fail|not\s*found)|route.*not\s*found|no\s*destination.*found/i)) {
      const routeMatch = err.match(/(?:route|destination)\s*[:=]?\s*['"]?(\w[\w/.]+)/i);
      addDep(
        `Error de navegacion${routeMatch ? `: ruta ${routeMatch[1]} no encontrada` : ' — destino no encontrado'}`,
        `La app no puede navegar a una pantalla requerida. Error: "${err.substring(0, 400)}"`,
        'tool-error',
        'high'
      );
    }

    // APK install failures
    if (errLower.match(/install.*fail|failure\s*\[install|session.*fail|pm\s+install.*error/i)) {
      const reasonMatch = err.match(/(?:failure|error)[:\s]+\[?([\w_]+)\]?/i);
      addDep(
        `Fallo al instalar el APK${reasonMatch ? `: ${reasonMatch[1]}` : ''}`,
        `No se pudo instalar la app en el emulador/dispositivo. Error: "${err.substring(0, 300)}"`,
        'tool-error',
        'high'
      );
    }

    // Emulator / ADB errors
    if (errLower.match(/emulator.*(?:not\s*found|offline|not\s*running)|adb.*(?:not\s*found|error|offline)|device\s*(?:not\s*found|offline)/i)) {
      addDep(
        'Emulador o dispositivo Android no disponible',
        `El emulador no esta corriendo o no responde. Hay que verificar que el AVD este configurado. Error: "${err.substring(0, 300)}"`,
        'tool-error',
        'normal'
      );
    }

    // Gradle / Build OOM / Daemon issues
    if (errLower.match(/outofmemoryerror|java\.lang\.outofmemory|heap\s*space|metaspace|gradle.*daemon.*(?:disappeared|stopped|expired)|could\s*not\s*create.*jvm/i)) {
      addDep(
        'Gradle se quedo sin memoria durante el build',
        `La JVM se quedo sin heap durante la compilacion. Puede ser necesario matar daemons o liberar RAM. Error: "${err.substring(0, 300)}"`,
        'tool-error',
        'normal'
      );
    }

    // Auth / Cognito errors (solo si no es en un test)
    if (errLower.match(/(?:status|code)\s*[:=]\s*401|(?:status|code)\s*[:=]\s*403|token\s*(?:expired|invalid)|cognito.*error|not\s*authorized|accessdenied/i) && !errLower.includes('test')) {
      addDep(
        'Error de autenticacion — token expirado, invalido o sin permisos',
        `La app no puede autenticarse contra el backend. Puede ser un token vencido o credenciales incorrectas. Error: "${err.substring(0, 300)}"`,
        'tool-error',
        'normal'
      );
    }

    // Timeout errors (conexión al backend lenta o caída)
    if (errLower.match(/(?:connect|read|socket|request)\s*timeout|timed?\s*out|deadline\s*exceeded/i) && !errLower.match(/enotfound|econnrefused/)) {
      const urlMatch = err.match(/(?:url|host|endpoint)\s*[:=]\s*['"]?(\S+)/i);
      addDep(
        `Timeout de conexion${urlMatch ? ` a ${urlMatch[1]}` : ' al backend'}`,
        `La conexion al servidor tardo demasiado. Puede estar sobrecargado o caido. Error: "${err.substring(0, 300)}"`,
        'tool-error',
        'normal'
      );
    }
  }

  // --- 3. Patrones simples en texto combinado (fallback) ---
  if (combined.includes('unexpected json') || combined.includes('unknownkeyexception'))
    addDep('Bug en parser JSON de otro servicio', 'La app crashea al parsear una respuesta del backend con campos desconocidos', 'pattern-match', 'high');
  if (combined.includes('clientsearchbusinesses') || (combined.includes('dashboard') && combined.includes('crash')))
    addDep('Bug en Dashboard / ClientSearchBusinessesService', 'El listado de negocios crashea, bloqueando la navegacion al feature bajo prueba', 'pattern-match', 'high');
  if (combined.includes('ignoreunknownkeys'))
    addDep('Falta ignoreUnknownKeys en un servicio client', 'El backend devuelve campos que el cliente no conoce y el parser es estricto — hay que agregar ignoreUnknownKeys = true', 'pattern-match', 'high');

  // Network errors (estos son infra, no dependencias de código, pero los reportamos para contexto)
  if (combined.match(/enotfound|econnrefused|etimedout|socket\s*hang\s*up/))
    addDep('Problema de red/DNS — no hay conexion a internet', 'El agente no pudo conectarse a internet o a servicios externos. Es un problema de infraestructura, no de codigo. No se evaluo nada.', 'infra', 'normal');

  // APK build failure pattern
  if (combined.match(/assemble.*fail|build.*apk.*fail|apk.*not\s*(?:found|generated)/i))
    addDep('El APK no se pudo generar', 'El build de Android fallo — el APK no existe. Sin APK no se puede probar en el emulador.', 'pattern-match', 'high');

  // Emulator not running pattern
  if (combined.match(/emulator.*not.*running|no.*(?:emulador|emulator|device)/i))
    addDep('Emulador Android no esta corriendo', 'Se necesita el emulador Android para ejecutar las pruebas QA. Verificar que el AVD este levantado.', 'pattern-match', 'normal');

  // --- 4. Patrones regex en texto crudo (menciones explícitas de dependencias) ---
  const featurePatterns = [
    /no\s+(?:existe|implementad[oa]|disponible)\s+(?:la?\s+)?(?:pantalla|screen|feature|funcionalidad)\s+(?:de\s+)?(\w[\w\s]{3,30})/gi,
    /falta\s+(?:implementar|construir|crear)\s+(\w[\w\s]{3,30})/gi,
    /depende\s+de\s+(?:#(\d+)|(\w[\w\s]{3,30}))/gi,
    /bloqueado\s+por\s+(?:#(\d+)|(\w[\w\s]{3,30}))/gi,
    /antes\s+(?:hay\s+que|se\s+debe|necesita)\s+(?:corregir|arreglar|implementar)\s+([\w\s]{5,50})/gi,
  ];
  // Stop words/phrases: frases genéricas que no aportan como dependencia accionable
  const genericPhrases = /^(?:(?:el|la|un|una|otro|otra|este|esta|ese|esa|los|las)\s+)*(?:nuevo|nueva|cambios?|correccion|correcci[oó]n|feature|funcionalidad|implementacion|implementaci[oó]n|problema|error|bug|fallo|issue|cosa|parte|m[oó]dulo|componente|servicio|pantalla|arreglo|fix|soluci[oó]n|mejora)\s*$/i;

  for (const pattern of featurePatterns) {
    let match;
    while ((match = pattern.exec(logTail || '')) !== null) {
      const dep = (match[1] || match[2] || match[3] || '').trim();
      // Filtrar: mínimo 5 chars, no genérico, y debe contener al menos una palabra con mayúscula o ser suficientemente específico
      if (dep && dep.length > 5 && !genericPhrases.test(dep) && dep.split(/\s+/).length <= 8) {
        addDep(dep, `Mencion explicita en el log: "${match[0]}"`, 'regex-match', 'high');
      }
    }
  }

  // --- 5. Ordenar: high priority primero ---
  deps.sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1));

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

  // Fallback inteligente: extraer info real del log
  const parsedLog = parseLogErrors(logTail);
  const lastAgentMsg = parsedLog.agentMessages.filter(m => m.length > 30).slice(-1)[0] || '';
  const lastToolErr = parsedLog.toolErrors.slice(-1)[0] || '';
  const extractedDetail = lastToolErr
    ? `Ultimo error detectado: "${lastToolErr.substring(0, 150).replace(/\n/g, ' ')}"`
    : lastAgentMsg
    ? `Ultimo mensaje del agente: "${lastAgentMsg.substring(0, 150).replace(/\n/g, ' ')}"`
    : `Motivo registrado: "${motivo}"`;

  result.conclusion = 'El agente termino con codigo ' + code + ' despues de ' + elapsed + ' segundos. ' + extractedDetail;
  result.factors.push('Codigo de salida: ' + code + (parseInt(code) !== 0 ? ' (terminacion anormal)' : ''));
  if (lastToolErr) result.factors.push('Error en herramienta: ' + lastToolErr.substring(0, 100).replace(/\n/g, ' '));
  if (lastAgentMsg && lastAgentMsg !== lastToolErr) result.factors.push('Diagnostico del agente: ' + lastAgentMsg.substring(0, 100).replace(/\n/g, ' '));

  if (result.externalDeps.length > 0) {
    result.suggestion = 'Se detectaron ' + result.externalDeps.length + ' dependencias externas que pueden estar bloqueando. Resolver primero las dependencias y luego reintentar.';
    result.steps = result.externalDeps.map((d, i) => (typeof d === 'object' ? d.summary : d));
    result.steps.push('Una vez resueltas las dependencias, reintentar automaticamente');
  } else {
    result.suggestion = 'Revisar el log del agente enfocandose en los errores y el diagnostico extraido arriba.';
    result.steps = ['Revisar el detalle del error extraido arriba', 'Identificar si es un problema del codigo, infra o dependencia', 'Corregir y reintentar'];
  }
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
  <tr><th>Origen</th><td>${rootCause.origen === 'EXTERNO' ? '⚠️ El problema NO esta en el codigo de este issue — es un factor externo (infra, dependencia de otro feature, bug en otra pantalla)' : rootCause.origen === 'INTERNO' ? '🔴 El problema esta en los cambios de este issue — requiere correccion del desarrollador' : '🔍 Requiere revision — ver log y factores contribuyentes abajo para mas contexto'}</td></tr>
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
  ${analysis.externalDeps && analysis.externalDeps.length > 0 && autoCreatedDeps.length === 0 ? '<h3>Dependencias externas detectadas</h3><table><tr><th>Dependencia</th><th>Detalle</th><th>Fuente</th></tr>' + analysis.externalDeps.map(d => {
    const summary = typeof d === 'object' ? d.summary : d;
    const detail = typeof d === 'object' ? (d.detail || '') : '';
    const source = typeof d === 'object' ? (d.source || 'auto') : 'auto';
    return '<tr><td><strong>' + escapeHtml(summary) + '</strong></td><td>' + escapeHtml(detail.substring(0, 200)) + '</td><td><span class="badge badge-blue">' + escapeHtml(source) + '</span></td></tr>';
  }).join('') + '</table><p><em>No se pudieron crear issues automaticamente. Crear manualmente antes de reintentar.</em></p>' : ''}
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
  Intrale Platform &mdash; Reporte de Rechazo &mdash; v5.1 &mdash; ${escapeHtml(isoDate)}
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
    : 'Requiere revisión del log para determinar el origen exacto. Los factores contribuyentes dan más contexto.';
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
      parts.push(`Se crearon automáticamente ${newOnes.length} issues de dependencia: ${newOnes.map(d => 'número ' + (d.number || '?') + ', ' + (d.title || '').replace(/^dep:\s*/i, '')).join('. ')}.`);
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
// Dedup: delegado al pipeline de definición (brazoIntake en pulpo.js)
// El rejection report ya no hace dedup propio contra GitHub.
// Solo mantiene dedup interno (dentro del mismo reporte) via addDep().
// =============================================================================

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

  // Hay dependencias externas — encolar creación con needs-definition
  // El dedup cross-rejection lo maneja el pipeline de definición (brazoIntake en pulpo.js)
  console.log(`[rejection-report] ${externalDeps.length} dependencias externas detectadas — encolando en pipeline de definición...`);
  const newDeps = externalDeps;  // todas van al pipeline, él filtra duplicados

  // Determinar path del worktree para persistir el contexto
  const worktreePath = path.join(ROOT, '..', `platform.agent-${issue}-${skill}`);
  const contextDir = fs.existsSync(worktreePath) ? worktreePath : LOG_DIR;
  const contextPath = path.join(contextDir, `.rejection-context-${issue}-${skill}.json`);

  // Persistir contexto para fase 2 (sin existingDeps — dedup delegado al pipeline)
  data.existingDeps = [];
  fs.writeFileSync(contextPath, JSON.stringify(data, null, 2));
  console.log(`[rejection-report] Contexto persistido en ${contextPath}`);

  // Encolar create-issue para cada dependencia nueva
  const group = `rejection-${issue}-${Date.now()}`;
  const issueTitle = data.issueCtx.title || '';

  for (const dep of newDeps) {
    const summary = typeof dep === 'object' ? dep.summary : dep;
    const detail = typeof dep === 'object' ? dep.detail : dep;
    const source = typeof dep === 'object' ? (dep.source || 'auto') : 'auto';
    const priority = typeof dep === 'object' ? (dep.priority || 'normal') : 'normal';

    // Título descriptivo y accionable (no genérico "dep: ...")
    // Determinar si es bug, infra, feature faltante, etc.
    const summaryLower = summary.toLowerCase();
    let prefix = 'fix';
    if (summaryLower.match(/^(?:falta|pantalla|ruta|requiere|depende)/)) prefix = 'feat';
    else if (summaryLower.match(/^(?:problema de red|emulador|gradle|timeout)/)) prefix = 'infra';
    else if (summaryLower.match(/^(?:error|bug|crash|la app)/)) prefix = 'fix';

    // Limpiar summary para título: quitar frases largas de contexto
    const cleanSummary = summary
      .replace(/\s*—\s*.{20,}$/, '')  // quitar todo después de " — explicación larga"
      .replace(/\s+que bloquea.*$/, '')  // quitar "que bloquea la ejecucion..."
      .substring(0, 80);

    const depTitle = `${prefix}: ${cleanSummary}`;

    // Body rico y accionable
    const depBody = [
      '## Contexto',
      '',
      `Este problema fue detectado automáticamente al analizar el rechazo del issue #${issue} (**${issueTitle}**).`,
      '',
      `| Campo | Valor |`,
      `|-------|-------|`,
      `| **Issue bloqueado** | #${issue} |`,
      `| **Agente que falló** | ${skill} |`,
      `| **Fase** | ${fase} |`,
      `| **Prioridad** | ${priority === 'high' ? '🔴 Alta — bloqueo directo' : '🟡 Normal — contribuyente'} |`,
      `| **Fuente de detección** | ${source} |`,
      '',
      '## Problema detectado',
      '',
      `### ${summary}`,
      '',
      detail,
      '',
      '## Por qué es importante',
      '',
      `El issue #${issue} (**${issueTitle}**) no puede avanzar mientras este problema exista. ` +
      `El agente \`${skill}\` intentó ejecutar la fase \`${fase}\` pero falló porque se encontró con este bloqueo.`,
      '',
      priority === 'high'
        ? '**Este es un bloqueo directo**: la funcionalidad del issue #' + issue + ' depende de que esto se resuelva primero.'
        : 'Este es un factor contribuyente al rechazo. Resolverlo puede permitir que el issue #' + issue + ' avance.',
      '',
      '## Criterios de aceptación',
      '',
      '- [ ] El problema descrito arriba está corregido',
      `- [ ] El issue #${issue} puede reintentarse sin este bloqueo`,
      '- [ ] Se verificó que la corrección no introduce regresiones',
      '',
      '## Notas para el desarrollador',
      '',
      `- Revisar el [rejection report](../docs/qa/) del issue #${issue} para más contexto`,
      `- Este issue fue detectado por \`${source}\` analizando los logs del agente`,
      `- Una vez resuelto, el pipeline reintentará automáticamente el issue #${issue}`,
      '',
      '---',
      `_Issue creado automáticamente por el rejection report del pipeline v5.1._`,
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
