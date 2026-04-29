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
const dedupLib = require('./dedup-lib');
// #2333: sanitizador write-time antes de generar PDF. Nunca persistimos un
// reporte con secretos crudos (tokens, JWT, PEM, etc.) que luego viaja a
// Telegram/Drive.
const { sanitize: sanitizeReportText } = require('./sanitizer');
// #2351: el match "APK no se pudo generar" era falso positivo cuando fallaban
// sólo tasks Release (bug AGP+KMP) mientras los APKs Debug se generaban bien.
// Este helper nos da extract-failure-lines + checkDebugApksFresh + dismiss log.
const apkFreshness = require('./lib/apk-freshness');

const ROOT = path.resolve(__dirname, '..');
const PIPELINE = __dirname;
const LOG_DIR = path.join(PIPELINE, 'logs');
const METRICS_FILE = path.join(PIPELINE, 'metrics-history.jsonl');
const PROFILES_FILE = path.join(PIPELINE, 'skill-profiles.json');
const REPORT_SCRIPT = path.join(ROOT, 'scripts', 'report-to-pdf-telegram.js');
const GH_CLI = process.env.GH_CLI_PATH || 'C:/Workspaces/gh-cli/bin/gh.exe';
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

// --- Preflight del pulpo: ¿el emulador estaba OK antes del run actual? ---
// Lee pulpo.log y busca la última línea `check 4 OK` para el issue en las
// últimas 2 horas. Si aparece → preflight validó que el emulador estaba
// disponible + screenrecord funcionando. Un rejection que diga "emulador
// caído" con preflight OK es un falso positivo.
function checkPreflightOk(issueNum) {
  const logPath = path.join(LOG_DIR, 'pulpo.log');
  if (!fs.existsSync(logPath)) return { ok: false, reason: 'pulpo.log no disponible' };
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size;
    // Leer solo la cola (últimos 512KB típicamente cubren 2h+)
    const readSize = Math.min(size, 512 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const lines = tail.split('\n').reverse();
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const okPattern = new RegExp(`\\[preflight\\] #${issueNum}: check 4 OK`);
    const failPattern = new RegExp(`\\[preflight\\] #${issueNum}:.*(?:FAIL|waiting:emulator)`);
    for (const line of lines) {
      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
      if (tsMatch) {
        const ts = Date.parse(tsMatch[1].replace(' ', 'T') + '-03:00');
        if (ts < cutoff) break;
      }
      if (failPattern.test(line)) return { ok: false, reason: 'preflight FAIL detectado', line };
      if (okPattern.test(line)) return { ok: true, line };
    }
    return { ok: false, reason: 'sin registro de preflight en las últimas 2h' };
  } catch (e) {
    return { ok: false, reason: 'error leyendo pulpo.log: ' + e.message };
  }
}

// --- Evidencia directa en disco: hash de video, # frames, path del log ---
function collectEvidence(issueNum, skillName, logFileName) {
  const evidence = {
    video: null,
    videoBytes: 0,
    videoHash: null,
    frames: 0,
    logPath: null,
    logBytes: 0,
  };
  const qaDirs = [
    path.join(ROOT, 'qa', 'evidence', String(issueNum)),
    path.join(ROOT, 'qa', 'recordings'),
    path.join(LOG_DIR),
  ];
  for (const dir of qaDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile()) continue;
        if (f.endsWith('.mp4') && f.includes(String(issueNum))) {
          const sz = fs.statSync(full).size;
          if (sz > evidence.videoBytes) {
            evidence.video = full;
            evidence.videoBytes = sz;
          }
        } else if (f.endsWith('.png') && f.includes(String(issueNum))) {
          evidence.frames++;
        }
      }
    } catch {}
  }
  if (evidence.video) {
    try {
      const crypto = require('crypto');
      const sample = fs.readFileSync(evidence.video).slice(0, 65536);
      evidence.videoHash = crypto.createHash('md5').update(sample).digest('hex').slice(0, 12);
    } catch {}
  }
  const logPath = path.join(LOG_DIR, logFileName);
  if (fs.existsSync(logPath)) {
    evidence.logPath = logPath;
    try { evidence.logBytes = fs.statSync(logPath).size; } catch {}
  }
  return evidence;
}

// --- Contexto del issue desde GitHub ---
function fetchIssueContext(issueNum) {
  const ghPath = fs.existsSync(GH_CLI) ? GH_CLI : 'gh';
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = execSync(
        `"${ghPath}" issue view ${issueNum} --json title,body,labels --repo intrale/platform`,
        { timeout: 20000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const data = JSON.parse(raw);
      const bodyLines = (data.body || '').split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('-'));
      const summary = bodyLines.slice(0, 3).join(' ').substring(0, 300);
      return {
        title: data.title || `Issue #${issueNum}`,
        labels: (data.labels || []).map(l => l.name),
        summary: summary || '(sin descripción)',
      };
    } catch (e) {
      console.error(`[rejection-report] fetchIssueContext #${issueNum} intento ${attempt}/${MAX_RETRIES}: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        // Esperar 2s antes de reintentar
        execSync('timeout /t 2 /nobreak >nul 2>&1 || sleep 2', { windowsHide: true, stdio: 'ignore' });
      }
    }
  }

  console.error(`[rejection-report] fetchIssueContext #${issueNum} FALLIDO tras ${MAX_RETRIES} intentos — gh path: ${ghPath}, existe: ${fs.existsSync(ghPath)}`);
  return { title: `Issue #${issueNum}`, labels: [], summary: '(no se pudo leer el issue de GitHub)' };
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
                  criteriosNoVerificados: data.criterios_no_verificados || [],
                  evidenciaParcial: data.evidencia_parcial || [],
                  modo: data.modo || null,
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

// --- Veredicto del agente que rechazó (fuente de verdad por encima del keyword matching) ---
// Cuando el agente escribe su YAML con `resultado: rechazado` y un `motivo`,
// ese motivo es la razón real del rechazo. Ningún pattern-match sobre el log
// debe contradecirlo. Esta función construye un rootCause estructurado a
// partir del YAML + el skill que rechazó. Devuelve null si no hay veredicto
// utilizable (el caller cae al keyword matching legacy).
function buildAgentVerdict(yamlData, skill) {
  if (!yamlData || typeof yamlData !== 'object') return null;
  if (yamlData.resultado !== 'rechazado') return null;
  const motivoReal = (yamlData.motivo || '').trim();
  if (!motivoReal) return null;

  // Primera oración del motivo (para summary corto) + motivo completo (para detail).
  const firstSentence = motivoReal.split(/(?<=[.!?])\s+/)[0].trim();
  const summary = firstSentence.length > 180 ? firstSentence.substring(0, 180) + '...' : firstSentence;

  const byRole = {
    po: {
      tipo: 'PO-POLICY', emoji: '🧭', origen: 'DECISION-PRODUCTO',
      desc: `El Product Owner decidió no aprobar: ${motivoReal}`,
      negocio: `El responsable de producto revisó el cambio y pidió más evidencia o ajustes antes de aprobarlo. Motivo: ${motivoReal}`,
      label: 'Product Owner',
    },
    qa: {
      tipo: 'QA-FALLA', emoji: '🧪', origen: 'INTERNO',
      desc: `El agente QA rechazó: ${motivoReal}`,
      negocio: `Las pruebas de usuario detectaron un problema. Motivo: ${motivoReal}`,
      label: 'QA',
    },
    review: {
      tipo: 'CODE-REVIEW', emoji: '👁️', origen: 'INTERNO',
      desc: `Code review bloqueante: ${motivoReal}`,
      negocio: `La revisión de código encontró problemas que deben corregirse antes de continuar. Motivo: ${motivoReal}`,
      label: 'Code review',
    },
    tester: {
      tipo: 'TESTS', emoji: '🧪', origen: 'INTERNO',
      desc: `Tests automáticos fallaron: ${motivoReal}`,
      negocio: `Las pruebas automáticas detectaron una regresión. Motivo: ${motivoReal}`,
      label: 'Tester',
    },
    builder: {
      tipo: 'COMPILACION', emoji: '🔨', origen: 'INTERNO',
      desc: `Build falló: ${motivoReal}`,
      negocio: `Los cambios de código tienen errores que impiden generar la aplicación. Motivo: ${motivoReal}`,
      label: 'Builder',
    },
    security: {
      tipo: 'SEGURIDAD', emoji: '🛡️', origen: 'INTERNO',
      desc: `Auditoría de seguridad bloqueante: ${motivoReal}`,
      negocio: `La auditoría de seguridad detectó problemas que deben corregirse. Motivo: ${motivoReal}`,
      label: 'Security',
    },
    guru: {
      tipo: 'INVESTIGACION', emoji: '📚', origen: 'INTERNO',
      desc: `Guru reportó un bloqueante: ${motivoReal}`,
      negocio: `El análisis técnico encontró un problema de fondo. Motivo: ${motivoReal}`,
      label: 'Guru',
    },
    ux: {
      tipo: 'UX', emoji: '🎨', origen: 'INTERNO',
      desc: `Revisión UX bloqueante: ${motivoReal}`,
      negocio: `La revisión de experiencia de usuario pidió ajustes. Motivo: ${motivoReal}`,
      label: 'UX',
    },
  };

  const mapped = byRole[skill] || {
    tipo: 'AGENTE-RECHAZO', emoji: '📋', origen: 'INTERNO',
    desc: `El agente ${skill} rechazó: ${motivoReal}`,
    negocio: `El agente ${skill} dejó un veredicto de rechazo. Motivo: ${motivoReal}`,
    label: skill || 'agente',
  };

  return {
    ...mapped,
    fromYaml: true,
    summary,
    motivoReal,
    skill: skill || 'agente',
  };
}

// --- Clasificación de causa raíz ---
function classifyRootCause(motivo, logTail, exitCode, yamlData, skill) {
  // Fuente de verdad #1: el YAML del agente que rechazó.
  const agentVerdict = buildAgentVerdict(yamlData, skill);
  if (agentVerdict) return agentVerdict;


  const motivoLower = (motivo || '').toLowerCase();
  const logLower = (logTail || '').toLowerCase();

  // Detectar señales en el log para no contradecirse entre secciones
  const hasAppCrash = logLower.includes('unexpected json') || logLower.includes('crash') ||
    (logLower.includes('exception') && !logLower.includes('doxxexception'));
  const hasEmulatorIssue = !!logLower.match(/emulator.*(?:not|no)|(?:no|not).*(?:emulador|emulator|device)|adb.*(?:not|error|offline)/i);
  const hasOOM = logLower.includes('enomem') || logLower.includes('out of memory') || logLower.includes('heap');

  // Infra pura: solo si NO hay evidencia de que la app llegó a correr
  if (logLower.includes('enotfound') || logLower.includes('econnrefused') || logLower.includes('unable to connect'))
    return { tipo: 'INFRAESTRUCTURA', emoji: '🔌', origen: 'EXTERNO',
      desc: 'El agente no pudo conectarse a internet o a un servicio externo. No tiene nada que ver con el código del issue.',
      negocio: 'La prueba no se ejecutó porque hubo un problema de red. El código no fue evaluado.' };
  if (hasOOM && !hasAppCrash)
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
    if (hasAppCrash && hasEmulatorIssue) {
      return { tipo: 'BLOQUEO-MULTIPLE', emoji: '🚧', origen: 'EXTERNO',
        desc: 'Multiples bloqueos: la app crashea en otra pantalla y ademas hubo problemas con el emulador. La funcionalidad no pudo evaluarse.',
        negocio: 'La prueba no pudo completarse por dos motivos: la app tiene un bug en otra pantalla que impide navegar al feature, y ademas hubo problemas con el emulador. El feature en si no fue evaluado — los issues de dependencia detallan cada bloqueo.' };
    }
    if (hasAppCrash) {
      return { tipo: 'QA-EVIDENCIA', emoji: '📹', origen: 'EXTERNO',
        desc: 'El agente QA no pudo generar evidencia porque la app crasheó antes de llegar a la pantalla del feature.',
        negocio: 'La app tiene un bug en otra pantalla que impide llegar a probar esta funcionalidad. El feature en sí no fue evaluado.' };
    }
    if (hasEmulatorIssue) {
      return { tipo: 'QA-EVIDENCIA', emoji: '📹', origen: 'EXTERNO',
        desc: 'El emulador o dispositivo Android no estaba disponible. Sin emulador no se puede ejecutar la app ni generar evidencia.',
        negocio: 'No habia emulador o dispositivo Android disponible para ejecutar la prueba. El feature no fue evaluado — es un problema de infraestructura.' };
    }
    return { tipo: 'QA-EVIDENCIA', emoji: '📹', origen: 'INTERNO',
      desc: 'El agente QA ejecutó pero no generó el video/audio de evidencia requerido.',
      negocio: 'La prueba se ejecutó pero no se grabó correctamente el video. Puede ser un problema técnico de grabación.' };
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
    //
    // Guard anti-falsos: descartar si el "error" parece un dump de config/JSON literal
    // (es común que los agentes loggeen `config.yaml: { timeout_ms: 5000 }` en
    // tool-output, y antes se clasificaba como "Timeout de conexión al backend"
    // fantasma). Exigimos marcadores reales de error (stack/exception/fail/cause).
    const looksLikeConfigDump = /\{\s*"?\w+"?\s*:\s*\d+/.test(err) &&
      !/exception|stack|caused\s+by|fail(?:ed|ure)?|error(?:code|message|:)|at\s+[\w.]+\(/i.test(err);
    if (!looksLikeConfigDump &&
        errLower.match(/(?:connect|read|socket|request)\s*timeout|timed?\s*out|deadline\s*exceeded/i) &&
        !errLower.match(/enotfound|econnrefused/)) {
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
  //
  // #2351 — Historial: este pattern venía disparando el issue fantasma
  // "El APK no se pudo generar" cuando en realidad fallaba sólo una task
  // Release (bug conocido de AGP + Kotlin MP en
  // `bundle<Flavor>ReleaseClassesToRuntimeJar`) y los APKs Debug se generaban
  // bien. Endurecimos el match con:
  //   R5 — sólo aplicar el regex a líneas de falla real (FAILURE:/Task FAILED),
  //        nunca al buffer crudo que incluye paths, comentarios, etc.
  //   R2 — si el regex matchea, verificar APKs Debug en disco y considerarlos
  //        válidos sólo cuando `mtime > buildStartTime` (un APK stale de hace
  //        3 días no puede enmascarar un build actual roto).
  //   R3 — loguear JSON inline cuando descartamos el match, para auditoría.
  if (apkFreshness.matchesApkFailureInFailureLines(combined)) {
    const buildStartTimeMs = apkFreshness.estimateBuildStartTimeMs({ elapsedSec: elapsed });
    const apkStatus = apkFreshness.checkDebugApksFresh({
      rootDir: ROOT,
      buildStartTimeMs,
    });
    if (apkStatus.anyFresh) {
      const dismissEvt = apkFreshness.buildDismissEvent({
        issue,
        pattern: 'apk_not_generated',
        reason: 'APK(s) debug frescos presentes — la falla probable es sólo de tasks Release (bug AGP+KMP)',
        apkStatus,
      });
      try { console.error(`[rejection-report] match-dismissed ${JSON.stringify(dismissEvt)}`); } catch {}
    } else {
      addDep('El APK no se pudo generar', 'El build de Android fallo — el APK no existe. Sin APK no se puede probar en el emulador.', 'pattern-match', 'high');
    }
  }

  // Emulator not running pattern
  //
  // Regex restringido: antes era `no.*(?:emulador|emulator|device)` — matcheaba
  // "no" + cualquier texto + "device", generando falsos positivos en cualquier
  // log Android que mencionara la palabra "device" o "emulator" en contextos
  // no-error (descripción del issue, comments, nombres de clase, etc).
  //
  // Ahora exige phrasings explícitos de infra caída:
  //   - "emulator not running/responding/found/available"
  //   - "no emulator/device/avd available/running/detected"
  //   - "device offline", "daemon not running"
  if (combined.match(/\bemulator\s+(?:is\s+)?not\s+(?:running|responding|found|available)\b|\bno\s+(?:hay\s+)?(?:emulador|emulator|device|avd)\s+(?:disponible|available|detected|found|levantado|corriendo|running)\b|\bdevice\s+offline\b|\bdaemon\s+not\s+running\b/i))
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

  // --- 5. Filtrar contradicciones ---
  // Si hay evidencia de que la app corrió (crash, exception, login, navegación),
  // el emulador SÍ estaba disponible — quitar deps de emulador espurias.
  // Excepción: si el motivo del rechazo es "sin evidencia / sin video", las
  // menciones en logs pueden ser de intentos previos o contexto — NO asumir
  // que la app corrió en esta ejecución.
  const evidenceRejection = /\b(?:sin\s+)?(?:evidencia|video|audio|frames?|screenrecord|\.mp4|grabaci[oó]n)\b/i.test(motivoLower);
  const appRan = !evidenceRejection && deps.some(d =>
    d.summary.match(/crash|bug|error.*json|dashboard|login|pantalla|navegacion|exception/i)
  );
  const filtered = appRan
    ? deps.filter(d => !d.summary.match(/^(?:emulador|emulator|dispositivo).*(?:no disponible|not|no esta)/i))
    : deps;

  // --- 6. Ordenar: high priority primero ---
  filtered.sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1));

  return filtered;
}

// --- Selección ESTRICTA de UNA sola causa raíz ---
// Retorna la mejor dep candidata o null si ninguna supera los criterios de
// estrictez. Filtra contra preflight: si detecta infra de emulador pero el
// preflight del pulpo pasó, descarta esa dep (falso positivo).
//
// El `motivo` del rechazo pesa más que los pattern-matches de log: cuando el
// rechazo es explícitamente por evidencia (sin video, sin frames), la causa
// está en la capa de ejecución (infra/emulador/APK), no en un bug funcional
// que aparezca mencionado incidentalmente en el log.
function selectPrimaryCause(deps, preflight, motivo, agentVerdict) {
  // Override absoluto: si hay veredicto del agente (YAML con resultado:rechazado),
  // ese es el primaryCause. No hay pattern-match que pueda contradecirlo.
  if (agentVerdict && agentVerdict.fromYaml) {
    return {
      summary: `${agentVerdict.label} rechazó: ${agentVerdict.summary}`,
      detail: agentVerdict.motivoReal,
      source: 'agent-verdict',
      priority: 'high',
      skill: agentVerdict.skill,
    };
  }

  if (!Array.isArray(deps) || deps.length === 0) return null;

  // Si preflight pasó, quitar deps de infra de emulador (falso positivo)
  let filtered = deps;
  if (preflight && preflight.ok) {
    filtered = deps.filter(d => {
      const s = (d.summary || '').toLowerCase();
      return !s.match(/emulador|emulator|dispositivo android|adb/);
    });
  }
  if (filtered.length === 0) return null;

  // Rechazo por evidencia → la causa real está en la capa de ejecución.
  // Los pattern-matches genéricos de la app (dashboard/crash/exception) son
  // contexto del log, no la razón del rechazo. Priorizar deps de infra;
  // caer a non-pattern-match si no hay infra; descartar pattern-match puros.
  const motivoLower = (motivo || '').toLowerCase();
  const evidenceRejection = /\b(?:sin\s+)?(?:evidencia|video|audio|frames?|screenrecord|\.mp4|grabaci[oó]n)\b/i.test(motivoLower);
  if (evidenceRejection) {
    const infraMatch = /emulador|emulator|apk|build|device|adb|screenrecord|evidencia|video|audio|frames?/i;
    const infraDeps = filtered.filter(d => infraMatch.test(d.summary || ''));
    if (infraDeps.length > 0) {
      filtered = infraDeps;
    } else {
      // Sin deps de infra: descartar pattern-match genéricos, dejar solo
      // deps con origen más confiable (agent-diagnostic, agent-explicit, regex-match).
      const nonPattern = filtered.filter(d => d.source !== 'pattern-match');
      if (nonPattern.length > 0) filtered = nonPattern;
    }
  }

  // Preferir priority:high; dentro de eso, preferir source != 'pattern-match'
  // (los pattern-match son los más susceptibles a falsos positivos)
  const ranked = filtered.slice().sort((a, b) => {
    const pA = a.priority === 'high' ? 0 : 1;
    const pB = b.priority === 'high' ? 0 : 1;
    if (pA !== pB) return pA - pB;
    const sA = a.source === 'pattern-match' ? 1 : 0;
    const sB = b.source === 'pattern-match' ? 1 : 0;
    return sA - sB;
  });
  return ranked[0];
}

// --- Buscar issues de dependencia creados en GitHub ---
function fetchDependencyIssues(issueNum) {
  try {
    const ghPath = fs.existsSync(GH_CLI) ? GH_CLI : 'gh';
    const raw = execSync(
      `"${ghPath}" issue list --label "qa:dependency" --json number,title,state,url --repo intrale/platform --limit 50`,
      { timeout: 20000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    const allDeps = JSON.parse(raw || '[]');

    let isBlocked = false;
    try {
      const issueRaw = execSync(
        `"${ghPath}" issue view ${issueNum} --json labels --repo intrale/platform`,
        { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const issueData = JSON.parse(issueRaw);
      isBlocked = (issueData.labels || []).some(l => l.name === 'blocked:dependencies');
    } catch {}

    let linkedDeps = [];
    try {
      const commentsRaw = execSync(
        `"${ghPath}" issue view ${issueNum} --json comments --repo intrale/platform`,
        { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
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

// --- Dedup pre-creación: busca un issue abierto con título similar y label qa:dependency ---
// Retorna { number, title, url } si encuentra match; null si no.
// La heurística vive en .pipeline/dedup-lib.js — misma lógica que pulpo.js usa
// en intake (evita que intake considere único lo que rejection-report vincula,
// o al revés).
function findExistingDepIssue(candidateTitle) {
  if (!candidateTitle) return null;
  try {
    const ghPath = fs.existsSync(GH_CLI) ? GH_CLI : 'gh';
    const raw = execSync(
      `"${ghPath}" issue list --label "qa:dependency" --state open --json number,title,url --repo intrale/platform --limit 100`,
      { timeout: 20000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    const open = JSON.parse(raw || '[]');
    return dedupLib.findDuplicate(candidateTitle, open);
  } catch {
    return null;
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
    const hasEmulatorIssue = logLower.match(/emulator.*(?:not|no)|(?:no|not).*(?:emulador|emulator|device)|adb.*(?:not|error|offline)/i);

    if (hasExternalBlocker && hasEmulatorIssue) {
      // Ambos problemas presentes — reportar los dos sin contradecirse
      result.conclusion = 'Se detectaron multiples bloqueos: (1) hay un bug en otra parte de la app que impide navegar al feature bajo prueba, y (2) problemas con el emulador o dispositivo Android. El rechazo por "evidencia incompleta" es un sintoma de estos bloqueos, no la causa.';
      result.factors.push('La app tiene un bug en otra pantalla que bloquea la navegacion al feature');
      result.factors.push('El emulador o dispositivo Android tambien presento problemas');
      result.factors.push('El rechazo por "evidencia incompleta" es un SINTOMA, no la causa');
      if (logLower.includes('unexpected json')) result.factors.push('Error de parsing JSON: el backend devuelve campos que la app no conoce');
    } else if (hasExternalBlocker) {
      result.conclusion = 'El agente QA intento probar el feature pero la app tiene un bug en OTRA pantalla que impide llegar a la funcionalidad. El rechazo dice "evidencia incompleta" pero la causa real es que la app crashea antes de poder probar nada.';
      result.factors.push('La app crashea antes de llegar al feature bajo prueba');
      result.factors.push('El rechazo por "evidencia incompleta" es un SINTOMA, no la causa');
      if (logLower.includes('unexpected json')) result.factors.push('Error de parsing JSON: el backend devuelve campos que la app no conoce');
    } else if (hasEmulatorIssue) {
      result.conclusion = 'El emulador o dispositivo Android no estaba disponible o no respondio durante la prueba. Sin emulador no se puede ejecutar la app ni generar evidencia de video.';
      result.factors.push('Emulador o dispositivo Android no disponible');
      if (motivoLower.includes('video_size')) result.factors.push('No se genero video porque no habia dispositivo donde ejecutar la app');
    } else {
      result.conclusion = 'El agente QA ejecuto la prueba pero no genero evidencia valida (video o audio). Puede ser un problema tecnico de grabacion (emulador, screenrecord, permisos).';
      result.factors.push('Gate de evidencia on-exit rechazo el resultado');
      if (motivoLower.includes('video_size')) result.factors.push('Video ausente o demasiado pequeno (<200KB)');
      if (motivoLower.includes('audio')) result.factors.push('Video sin narracion de audio');
      if (motivoLower.includes('no encontrado')) result.factors.push('Archivo de video no encontrado en disco');
    }

    // Steps y suggestion: cuando hay dependencias externas, referenciarlas directamente
    if (result.externalDeps.length > 0) {
      result.suggestion = 'Este issue esta bloqueado por ' + result.externalDeps.length + ' dependencia(s) externa(s). No requiere cambios propios — se desbloqueara automaticamente cuando se resuelvan los issues de dependencia.';
      result.steps = result.externalDeps.map(d => 'Resolver: ' + (typeof d === 'object' ? d.summary : d));
      result.steps.push('Una vez resueltas todas las dependencias, el pipeline reintentara QA automaticamente');
    } else if (hasExternalBlocker || hasEmulatorIssue) {
      result.suggestion = 'Resolver los bloqueos externos detectados. Este issue NO necesita cambios propios.';
      result.steps = ['Revisar las dependencias externas listadas en este reporte', 'Resolver cada una en su propio issue', 'El pipeline reintentara QA automaticamente cuando se desbloquee'];
    } else {
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
    result.suggestion = 'Este issue esta bloqueado por ' + result.externalDeps.length + ' dependencia(s) externa(s). No requiere cambios propios — se desbloqueara automaticamente cuando se resuelvan los issues de dependencia.';
    result.steps = result.externalDeps.map(d => 'Resolver: ' + (typeof d === 'object' ? d.summary : d));
    result.steps.push('Una vez resueltas todas las dependencias, el pipeline reintentara automaticamente');
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

  // Buscar el YAML del agente que rechazó en todas las fases y estados.
  // Incluye 'aprobacion' (donde vive el PO) y 'procesado/' (si el pulpo ya movió).
  let yamlData = null;
  const allFases = ['analisis', 'sizing', 'dev', 'build', 'verificacion', 'aprobacion', 'entrega'];
  const allBuckets = ['listo', 'procesado', 'trabajando', 'rechazado'];
  outer: for (const f of allFases) {
    for (const b of allBuckets) {
      const p = path.join(PIPELINE, pipeline, f, b, `${issue}.${skill}`);
      if (fs.existsSync(p)) {
        try {
          const yaml = require('js-yaml');
          yamlData = yaml.load(fs.readFileSync(p, 'utf8'));
        } catch {}
        break outer;
      }
    }
  }

  const cooldowns = readJson(path.join(PIPELINE, 'cooldowns.json')) || {};
  const cooldownKey = `${skill}:${issue}`;
  const cooldownInfo = cooldowns[cooldownKey];

  const analysis = analyzeRejection(exitCode, elapsed, motivo, logTail, avgCpu, avgMem, skill);
  const issueCtx = fetchIssueContext(issue);
  const rejectHistory = getRejectHistory(issue);
  const otherGates = getGateStatus(issue);
  const rootCause = classifyRootCause(motivo, logTail, exitCode, yamlData, skill);
  const readableLog = extractMeaningfulLog(logTail, 30);
  const depIssues = fetchDependencyIssues(issue);

  // NUEVO v6: preflight + evidencia + UNA causa raíz estricta
  const preflight = checkPreflightOk(issue);
  const evidence = collectEvidence(issue, skill, logFile);
  const primaryCause = selectPrimaryCause(analysis.externalDeps || [], preflight, motivo, rootCause && rootCause.fromYaml ? rootCause : null);

  // Veredicto: si la única causa candidata fue filtrada por preflight OK,
  // el rechazo es INCONCLUYENTE — no crear issue, marcar para revisión humana
  const hasFilteredCandidates = (analysis.externalDeps || []).length > 0;
  const inconclusive = preflight.ok && hasFilteredCandidates && !primaryCause;
  const verdict = inconclusive
    ? 'INCONCLUYENTE'
    : primaryCause
    ? 'RECHAZADO_CON_CAUSA'
    : 'RECHAZADO_SIN_CAUSA';

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
    // NUEVO v6
    preflight, evidence, primaryCause, verdict, inconclusive,
  };
}

// =============================================================================
// renderHtml(data) — reporte estricto v6: veredicto + causa única + evidencia
// =============================================================================
function renderHtml(data) {
  const {
    issue, skill, fase, elapsed, motivo, timestamp, isoDate,
    issueCtx, rejectHistory,
    logTail, readableLog, depIssues, autoCreatedDeps,
    preflight, evidence, primaryCause, verdict, inconclusive,
  } = data;

  const verdictLabel = inconclusive
    ? 'INCONCLUYENTE'
    : primaryCause
    ? 'RECHAZADO'
    : 'RECHAZADO (sin causa identificada)';
  const verdictClass = inconclusive ? 'badge-yellow' : 'badge-red';

  const causeBlock = inconclusive
    ? `<p><strong>No se pudo identificar una causa raíz confiable.</strong></p>
       <p>El agente ${escapeHtml(skill)} declaró rechazo, pero el preflight confirmó que el emulador estaba disponible + screenrecord verificado. Sin evidencia adicional en el log, no se crea issue de dependencia.</p>
       <p><em>Preflight: ${escapeHtml(preflight.line || 'OK')}</em></p>
       <p><strong>Acción:</strong> revisión humana del log del agente. Reintento automático en próxima ventana QA.</p>`
    : primaryCause
    ? `<p><strong>${escapeHtml(primaryCause.summary)}</strong></p>
       <p>${escapeHtml(primaryCause.detail || primaryCause.summary)}</p>
       <p><span class="badge badge-blue">fuente: ${escapeHtml(primaryCause.source || 'auto')}</span>
          <span class="badge ${primaryCause.priority === 'high' ? 'badge-red' : 'badge-yellow'}">prioridad: ${escapeHtml(primaryCause.priority || 'normal')}</span></p>`
    : `<p>El agente terminó con código ${escapeHtml(String(data.exitCode))} después de ${escapeHtml(String(elapsed))}s.</p>
       <p>Motivo registrado: <em>${escapeHtml(motivo)}</em></p>
       <p>No se detectaron dependencias externas accionables en el log. Revisión humana requerida.</p>`;

  const evidenceBlock = `
    <table>
      <tr><th>Video</th><td>${evidence.video
        ? escapeHtml(path.basename(evidence.video)) + ` &mdash; ${(evidence.videoBytes / 1024).toFixed(0)} KB &mdash; md5:${escapeHtml(evidence.videoHash || 'N/A')}`
        : '<em>sin video</em>'}</td></tr>
      <tr><th>Frames PNG</th><td>${evidence.frames}</td></tr>
      <tr><th>Log del agente</th><td>${evidence.logPath
        ? escapeHtml(path.basename(evidence.logPath)) + ` &mdash; ${(evidence.logBytes / 1024).toFixed(0)} KB`
        : '<em>sin log</em>'}</td></tr>
      <tr><th>Preflight</th><td>${preflight.ok
        ? '<span class="badge badge-green">OK</span> ' + escapeHtml(preflight.line || '')
        : '<span class="badge badge-yellow">NO verificado</span> ' + escapeHtml(preflight.reason || '')}</td></tr>
    </table>
  `;

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

<h1>Rechazo QA &mdash; #${escapeHtml(issue)} ${escapeHtml(skill)}</h1>
<p><span class="badge ${verdictClass}">${escapeHtml(verdictLabel)}</span> &nbsp; ${escapeHtml(timestamp)} &nbsp; <code>${escapeHtml(fase)}</code></p>

<h2>Issue bajo prueba</h2>
<div class="context-box">
  <h3>#${escapeHtml(issue)} &mdash; ${escapeHtml(issueCtx.title)}</h3>
</div>

<h2>Causa identificada</h2>
<div class="${inconclusive ? 'history-box' : 'rootcause-box'}">
  ${causeBlock}
</div>

<h2>Evidencia directa</h2>
${evidenceBlock}

${autoCreatedDeps.length > 0 ? `
<h2>Issues involucrados</h2>
<table>
  <tr><th>Issue</th><th>Título</th><th>Estado</th></tr>
  ${autoCreatedDeps.map(d => '<tr><td><strong>#' + (d.number || '?') + '</strong></td><td>' + escapeHtml(d.title) + '</td><td>' + (d.failed ? '<span class="badge badge-red">falló al crear</span>' : d.alreadyExisted ? '<span class="badge badge-yellow">existente — evidencia agregada</span>' : '<span class="badge badge-blue">creado</span>') + '</td></tr>').join('')}
</table>` : ''}

${depIssues.linkedDeps.length > 0 && autoCreatedDeps.length === 0 ? `
<h2>Dependencias previas</h2>
<table>
  <tr><th>Issue</th><th>Título</th><th>Estado</th></tr>
  ${depIssues.linkedDeps.map(d => {
    const stateIcon = d.state === 'OPEN' ? '🔴' : d.state === 'CLOSED' ? '✅' : '•';
    const stateCls = d.state === 'CLOSED' ? 'gate-approved' : 'gate-rejected';
    return '<tr><td><strong>#' + d.number + '</strong></td><td>' + escapeHtml(d.title) + '</td><td class="' + stateCls + '">' + stateIcon + ' ' + escapeHtml(d.state) + '</td></tr>';
  }).join('')}
</table>` : ''}

${rejectHistory.length > 1 ? `
<p><em>Este issue ya fue rechazado ${rejectHistory.length} veces.</em></p>` : ''}

<details><summary>Log del agente (últimas 80 líneas)</summary>
<pre><code>${escapeHtml(logTail)}</code></pre>
</details>

<div class="footer">
  Intrale Platform &mdash; Rejection Report &mdash; v6 (estricto) &mdash; ${escapeHtml(isoDate)}
</div>
</body></html>`;
}

// =============================================================================
// generateNarration(data) — narración corta para TTS (20-30s, ~300 chars)
// =============================================================================
function generateNarration(data) {
  const { issue, primaryCause, inconclusive, autoCreatedDeps } = data;

  if (inconclusive) {
    return `Issue ${issue}: rechazo inconcluyente. El preflight confirmó emulador disponible pero el agente declaró rechazo. Requiere revisión humana del log.`;
  }

  if (primaryCause) {
    const summary = (primaryCause.summary || '').replace(/^(?:fix|feat|infra|dep):\s*/i, '');
    const trimmed = summary.length > 120 ? summary.substring(0, 120) + '...' : summary;
    const created = (autoCreatedDeps || []).filter(d => !d.failed && !d.alreadyExisted).length;
    const existing = (autoCreatedDeps || []).filter(d => d.alreadyExisted).length;
    let tail = '';
    if (created > 0) tail = ` Se creó issue de dependencia.`;
    else if (existing > 0) tail = ` Dependencia ya existente, se sumó evidencia.`;
    return `Issue ${issue}: rechazado. Causa: ${trimmed}.${tail}`;
  }

  return `Issue ${issue}: rechazado sin causa identificada. Revisión humana requerida.`;
}

// =============================================================================
// sendReport(data) — genera PDF + audio y envía a Telegram
// =============================================================================
async function sendReport(data) {
  const htmlRaw = renderHtml(data);
  // #2333: sanitizar write-time (NFC → sanitizeSecrets → sanitizeUtf8).
  // No tocamos el `normalize` usado para fuzzy-matching en otros lugares;
  // esto sólo envuelve el HTML que va a PDF/Telegram.
  const html = sanitizeReportText(htmlRaw);

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
    let tgConfig = {};
    try { tgConfig = JSON.parse(fs.readFileSync(TG_CONFIG, 'utf8')); } catch {}
    try {
      const { loadTelegramSecrets } = require('./lib/telegram-secrets');
      const sec = loadTelegramSecrets({ legacyConfigPath: TG_CONFIG });
      tgConfig.bot_token = sec.bot_token;
      tgConfig.chat_id = sec.chat_id;
    } catch {}

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

    // #2518 — usar perfil del agente que rechazó (Rulo/Nacho para qa,
    // Bigote/Agus para security, etc.) para que el audio en Telegram
    // tenga la voz del skill, no Claudito/Tommy (que quedan para mensajes
    // generales del sistema).
    const ttsProfile = data.skill || 'default';
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks.length > 1
        ? `Parte ${i + 1} de ${chunks.length}. ${chunks[i]}`
        : chunks[i];
      const audioBuffer = await textToSpeech(chunkText, { profile: ttsProfile });
      if (audioBuffer) {
        const sent = await sendVoiceTelegram(audioBuffer, tgConfig.bot_token, tgConfig.chat_id);
        console.log(`[rejection-report] Audio ${i + 1}/${chunks.length} enviado (profile=${ttsProfile}): ${sent ? 'OK' : 'FALLO'}`);
      } else {
        console.log(`[rejection-report] No se pudo generar audio TTS (chunk ${i + 1}, profile=${ttsProfile})`);
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

  // ───────────────────────────────────────────────────────────────────────────
  // Veredicto v6 estricto: 0 ó 1 issue por rejection report (nunca varios).
  //   - INCONCLUYENTE  → PDF + audio, sin crear nada (revisión humana)
  //   - SIN CAUSA      → PDF + audio, sin crear nada
  //   - CON CAUSA + ya existe issue similar → comment con evidencia + PDF
  //   - CON CAUSA + nueva → encolar 1 create-issue, PDF lo genera fase 2
  // ───────────────────────────────────────────────────────────────────────────

  if (data.inconclusive) {
    console.log(`[rejection-report] INCONCLUYENTE — preflight OK, no se crea issue. Revisión humana.`);
    await sendReport(data);
    return;
  }

  // Loop guard: si el issue rechazado YA es un dep auto-generado (qa:dependency),
  // no debemos crear otro dep a partir de él. Romper el ciclo auto-referente
  // donde un "Emulador no corriendo" #N se rechaza → rejection-report matchea
  // "emulador" en el log/body (que literalmente dice "emulador no corriendo")
  // → crea otro "Emulador no corriendo" #N+1 → loop infinito.
  const isSelfDep = (data.issueCtx.labels || []).includes('qa:dependency');
  if (isSelfDep) {
    console.log(`[rejection-report] LOOP_GUARD — #${issue} ya es qa:dependency, no se crea dep recursivo. PDF directo.`);
    await sendReport(data);
    return;
  }

  const primaryCause = data.primaryCause;
  if (!primaryCause) {
    console.log(`[rejection-report] RECHAZADO_SIN_CAUSA — PDF directo, sin crear issue.`);
    await sendReport(data);
    return;
  }

  // Gate de creación de issue dependiente (v7 — fix del bug del #2505/#2509):
  // Solo crear issue qa:dependency cuando la causa raíz es EXTERNA al scope
  // del issue rechazado (infra caída, servicio externo, puerto ocupado, etc.).
  //
  // Si el rechazo es INTERNO (el desarrollo no cumple los CA del propio issue,
  // decisión de producto del PO, etc.), NO crear issue nuevo: el rebote natural
  // del pulpo ya mueve el archivo de vuelta a dev/pendiente/ y android-dev
  // vuelve a ejecutar sobre el mismo issue con el contexto del rechazo.
  //
  // Crear un issue qa:dependency en rechazos INTERNOS produce redundancia
  // (el contenido del issue es lo mismo que android-dev ya va a retrabajar)
  // y genera deadlock si hay pausa parcial sin el nuevo issue en la allowlist.
  const origen = primaryCause.origen || 'INTERNO';
  const OPT_IN_INTERNAL = primaryCause.forceCreateDep === true;
  if (origen !== 'EXTERNO' && !OPT_IN_INTERNAL) {
    console.log(`[rejection-report] RECHAZO_INTERNO (origen=${origen}) — PDF + rebote natural, sin crear issue qa:dependency.`);
    await sendReport(data);
    return;
  }

  // Una causa raíz: armar título canonical
  const summary = primaryCause.summary || '';
  const detail = primaryCause.detail || summary;
  const source = primaryCause.source || 'auto';
  const priority = primaryCause.priority || 'normal';
  const summaryLower = summary.toLowerCase();
  let prefix = 'fix';
  if (summaryLower.match(/^(?:falta|pantalla|ruta|requiere|depende)/)) prefix = 'feat';
  else if (summaryLower.match(/^(?:problema de red|emulador|gradle|timeout)/)) prefix = 'infra';
  else if (summaryLower.match(/^(?:error|bug|crash|la app)/)) prefix = 'fix';
  const cleanSummary = summary
    .replace(/\s*—\s*.{20,}$/, '')
    .replace(/\s+que bloquea.*$/, '')
    .substring(0, 80);
  const depTitle = `${prefix}: ${cleanSummary}`;
  const issueTitle = data.issueCtx.title || '';

  // Dedup en el rejection-report (no esperar al pulpo, que con .paused no corre)
  const existing = findExistingDepIssue(depTitle);

  if (existing) {
    console.log(`[rejection-report] Causa ya cubierta por #${existing.number} — agrego evidencia, no creo duplicado.`);

    const evidenceComment = [
      `## 🔁 Nueva evidencia de rechazo`,
      ``,
      `Este problema bloqueó nuevamente al issue **#${issue}** (${issueTitle}) en la fase \`${fase}\`.`,
      ``,
      `| Campo | Valor |`,
      `|-------|-------|`,
      `| Issue rechazado | #${issue} |`,
      `| Agente | ${skill} |`,
      `| Fecha | ${data.timestamp} |`,
      `| Fuente de detección | ${source} |`,
      ``,
      `**Detalle:** ${detail}`,
      ``,
      `_Evidencia agregada automáticamente por el rejection report v6._`,
    ].join('\n');

    enqueueGitHub({
      action: 'comment',
      issue: existing.number,
      body: evidenceComment,
    });

    data.autoCreatedDeps = [{
      number: existing.number,
      title: existing.title,
      state: 'OPEN',
      alreadyExisted: true,
    }];

    await sendReport(data);
    enqueueCommentAndLabel(data.issue, data.autoCreatedDeps, issueTitle);
    return;
  }

  // Causa nueva → crear UN issue, diferir PDF a fase 2
  console.log(`[rejection-report] Causa nueva — encolando 1 create-issue (PDF se genera al completar).`);

  const worktreePath = path.join(ROOT, '..', `platform.agent-${issue}-${skill}`);
  const contextDir = fs.existsSync(worktreePath) ? worktreePath : LOG_DIR;
  const contextPath = path.join(contextDir, `.rejection-context-${issue}-${skill}.json`);
  data.existingDeps = [];
  fs.writeFileSync(contextPath, JSON.stringify(data, null, 2));

  const group = `rejection-${issue}-${Date.now()}`;
  const depBody = [
    '## Contexto',
    '',
    `Detectado al analizar el rechazo del issue #${issue} (**${issueTitle}**).`,
    '',
    `| Campo | Valor |`,
    `|-------|-------|`,
    `| **Issue bloqueado** | #${issue} |`,
    `| **Agente que falló** | ${skill} |`,
    `| **Fase** | ${fase} |`,
    `| **Prioridad** | ${priority === 'high' ? '🔴 Alta — bloqueo directo' : '🟡 Normal — contribuyente'} |`,
    `| **Fuente** | ${source} |`,
    '',
    '## Causa raíz',
    '',
    `### ${summary}`,
    '',
    detail,
    '',
    '## Criterios de aceptación',
    '',
    '- [ ] El problema descrito está corregido',
    `- [ ] El issue #${issue} puede reintentarse sin este bloqueo`,
    '- [ ] No introduce regresiones',
    '',
    '---',
    `_Issue creado automáticamente por el rejection report v6 (estricto, 1 causa por reporte)._`,
  ].join('\n');

  enqueueGitHub({
    action: 'create-issue',
    title: depTitle,
    body: depBody,
    labels: 'needs-definition,qa:dependency,priority:high',
    repo: 'intrale/platform',
    group,
    groupSize: 1,
    onComplete: {
      command: `node .pipeline/rejection-report.js --phase complete --context "${contextPath}"`
    }
  });
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
