/**
 * gradle-parser.js — parser determinístico del output de Gradle
 *
 * Convierte el stdout/stderr crudo de gradle en un objeto estructurado
 * con: resultado (BUILD SUCCESSFUL/FAILED), duración, tareas, verificaciones,
 * errores clasificados y lista de módulos compilados.
 *
 * Uso:
 *   const { parseGradleOutput, classifyError } = require('./gradle-parser');
 *   const result = parseGradleOutput(stdout, stderr);
 *   // result.success, result.duration_ms, result.errors[], result.verifications
 */

'use strict';

// ── Regex principales ────────────────────────────────────────────────
const RE_BUILD_SUCCESSFUL = /BUILD SUCCESSFUL in (?:(\d+)m )?(\d+)s/;
const RE_BUILD_FAILED = /BUILD FAILED in (?:(\d+)m )?(\d+)s/;
const RE_ACTIONABLE = /(\d+) actionable tasks?:\s*(.+)/;
const RE_TASK_EXEC = /^> Task (:[\w:-]+)(?:\s+(\w+))?\s*$/;
const RE_FAILURE_HEADER = /^FAILURE: Build failed with an exception\./;
const RE_WHAT_WENT_WRONG = /^\* What went wrong:\s*$/;
const RE_WHERE = /^\* Where:\s*$/;
const RE_EXECUTION_FAILED = /Execution failed for task '(:[\w:-]+)'\./;

// ── Clasificación de errores conocidos ────────────────────────────────
const ERROR_PATTERNS = [
  {
    type: 'java_home',
    regex: /(JAVA_HOME|JDK|jbr).*?(not found|does not exist|invalid|JDK_NOT_FOUND|no such file)/i,
    fix: 'Usar Temurin 21.0.7 — export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"',
    escalate_to: null,
    severity: 'infra',
  },
  {
    type: 'forbidden_strings',
    regex: /forbidden-strings|stringResource\s*\(|Res\.string\.|R\.string\./,
    fix: 'Usar helper resString() con androidStringId/composeId/fallback ASCII — ver docs/engineering/strings.md',
    escalate_to: 'android-dev',
    severity: 'code',
  },
  {
    type: 'kotlin_version_mismatch',
    regex: /kotlin version|different\s+kotlin|incompatible\s+kotlin|metadata\s+version/i,
    fix: 'Verificar gradle.properties y buildSrc — Kotlin 2.2.21 en toda la cadena',
    escalate_to: 'android-dev',
    severity: 'code',
  },
  {
    type: 'compose_resources',
    regex: /validateComposeResources|compose.*?resource.*?(missing|invalid|not found)/i,
    fix: 'Ejecutar :app:composeApp:validateComposeResources para ver resource pack roto',
    escalate_to: 'android-dev',
    severity: 'code',
  },
  {
    type: 'ascii_fallback',
    regex: /scanNonAsciiFallbacks|non-ascii|fallback.*?ascii/i,
    fix: 'Reemplazar caracteres no-ASCII en fallbacks usando fb() helper',
    escalate_to: 'android-dev',
    severity: 'code',
  },
  {
    type: 'unresolved_reference',
    regex: /error:.*?unresolved reference:\s+(\w+)/i,
    fix: 'Verificar import o existencia del símbolo',
    escalate_to: null, // determinado por módulo
    severity: 'code',
  },
  {
    type: 'type_mismatch',
    regex: /error:.*?type mismatch/i,
    fix: 'Corregir incompatibilidad de tipos Kotlin',
    escalate_to: null,
    severity: 'code',
  },
  {
    type: 'oom',
    regex: /OutOfMemoryError|java\.lang\.OutOfMemoryError|Metaspace|GC overhead limit/i,
    fix: 'Aumentar heap o correr con --no-daemon (Gradle daemon consume hasta 4GB)',
    escalate_to: null,
    severity: 'infra',
  },
  {
    type: 'test_failed',
    regex: /There were failing tests\.|Task.*?:test.*?FAILED|tests failed/i,
    fix: 'Revisar reporte de tests en build/reports/tests/',
    escalate_to: 'tester',
    severity: 'test',
  },
];

/**
 * Clasifica un texto de error según los patrones conocidos.
 * Devuelve el primer match o un objeto 'unknown' si no matchea ninguno.
 */
function classifyError(text, taskPath = null) {
  if (!text || typeof text !== 'string') {
    return { type: 'unknown', fix: null, escalate_to: null, severity: 'unknown' };
  }

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.regex.test(text)) {
      // Escalación según módulo si la categoría es code y no tiene target fijo
      let escalate_to = pattern.escalate_to;
      if (!escalate_to && pattern.severity === 'code' && taskPath) {
        if (/^:(backend|users)/.test(taskPath)) escalate_to = 'backend-dev';
        else if (/^:app/.test(taskPath)) escalate_to = 'android-dev';
      }
      return {
        type: pattern.type,
        fix: pattern.fix,
        escalate_to,
        severity: pattern.severity,
      };
    }
  }

  return {
    type: 'unknown',
    fix: 'Error no clasificado — revisar output crudo y escalar a dev skill del área',
    escalate_to: taskPath && /^:(backend|users)/.test(taskPath) ? 'backend-dev' : 'android-dev',
    severity: 'unknown',
  };
}

/**
 * Extrae duración en milisegundos de un match "BUILD ... in Xm Ys" o "Xs".
 */
function durationMs(minutesCapture, secondsCapture) {
  const m = parseInt(minutesCapture || '0', 10);
  const s = parseInt(secondsCapture || '0', 10);
  return (m * 60 + s) * 1000;
}

/**
 * Extrae el bloque "What went wrong" con su cuerpo hasta la próxima sección `*`.
 */
function extractWhatWentWrong(lines, startIdx) {
  const body = [];
  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\* /.test(line) || /^BUILD (SUCCESSFUL|FAILED)/.test(line)) break;
    body.push(line);
    i += 1;
  }
  return body.join('\n').trim();
}

/**
 * Parser principal — consume output completo y devuelve objeto estructurado.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {object} { success, build_status, duration_ms, modules, tasks,
 *                     verifications, errors, raw_length }
 */
function parseGradleOutput(stdout = '', stderr = '') {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/);

  const result = {
    success: false,
    build_status: 'UNKNOWN', // SUCCESSFUL | FAILED | UNKNOWN
    duration_ms: 0,
    modules: [],
    tasks: { total: 0, executed: 0, up_to_date: 0, from_cache: 0 },
    verifications: {
      verifyNoLegacyStrings: null,      // null = no corrió, true = OK, false = FAILED
      validateComposeResources: null,
      scanNonAsciiFallbacks: null,
    },
    errors: [],
    raw_length: combined.length,
  };

  const executedTasks = new Set();
  const failedTasks = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // BUILD SUCCESSFUL in Xm Ys
    const successMatch = line.match(RE_BUILD_SUCCESSFUL);
    if (successMatch) {
      result.success = true;
      result.build_status = 'SUCCESSFUL';
      result.duration_ms = durationMs(successMatch[1], successMatch[2]);
      continue;
    }

    // BUILD FAILED in Xm Ys
    const failedMatch = line.match(RE_BUILD_FAILED);
    if (failedMatch) {
      result.success = false;
      result.build_status = 'FAILED';
      result.duration_ms = durationMs(failedMatch[1], failedMatch[2]);
      continue;
    }

    // N actionable tasks: X executed, Y up-to-date, Z from cache
    const actionableMatch = line.match(RE_ACTIONABLE);
    if (actionableMatch) {
      result.tasks.total = parseInt(actionableMatch[1], 10);
      const details = actionableMatch[2];
      const execMatch = details.match(/(\d+)\s+executed/);
      const upToDateMatch = details.match(/(\d+)\s+up-to-date/);
      const cacheMatch = details.match(/(\d+)\s+from cache/);
      if (execMatch) result.tasks.executed = parseInt(execMatch[1], 10);
      if (upToDateMatch) result.tasks.up_to_date = parseInt(upToDateMatch[1], 10);
      if (cacheMatch) result.tasks.from_cache = parseInt(cacheMatch[1], 10);
      continue;
    }

    // > Task :module:taskName [STATUS]
    const taskMatch = line.match(RE_TASK_EXEC);
    if (taskMatch) {
      const taskPath = taskMatch[1];
      const status = taskMatch[2];
      executedTasks.add(taskPath);
      if (status === 'FAILED') {
        failedTasks.add(taskPath);
      }
      // Extraer módulo raíz
      const moduleMatch = taskPath.match(/^:([\w-]+)(?::|$)/);
      if (moduleMatch && !result.modules.includes(moduleMatch[1])) {
        result.modules.push(moduleMatch[1]);
      }
      // Detectar verificaciones conocidas
      if (/verifyNoLegacyStrings$/.test(taskPath)) {
        result.verifications.verifyNoLegacyStrings = status !== 'FAILED';
      } else if (/validateComposeResources$/.test(taskPath)) {
        result.verifications.validateComposeResources = status !== 'FAILED';
      } else if (/scanNonAsciiFallbacks$/.test(taskPath)) {
        result.verifications.scanNonAsciiFallbacks = status !== 'FAILED';
      }
      continue;
    }

    // * What went wrong:
    if (RE_WHAT_WENT_WRONG.test(line)) {
      const body = extractWhatWentWrong(lines, i);
      const taskPathMatch = body.match(RE_EXECUTION_FAILED);
      const taskPath = taskPathMatch ? taskPathMatch[1] : null;
      const classification = classifyError(body, taskPath);
      result.errors.push({
        task: taskPath,
        message: body,
        classification: classification.type,
        fix: classification.fix,
        escalate_to: classification.escalate_to,
        severity: classification.severity,
      });
      continue;
    }
  }

  // Si hubo BUILD FAILED pero no encontramos bloque "What went wrong", agregar uno genérico
  if (result.build_status === 'FAILED' && result.errors.length === 0) {
    result.errors.push({
      task: Array.from(failedTasks)[0] || null,
      message: 'Build failed — no se encontró bloque "What went wrong" en el output',
      classification: 'unknown',
      fix: 'Revisar output crudo',
      escalate_to: null,
      severity: 'unknown',
    });
  }

  return result;
}

/**
 * Genera un reporte markdown con el mismo formato que el skill LLM.
 */
function renderMarkdownReport(result, meta = {}) {
  const { issue = null, scope = 'default', duration_override_ms = null } = meta;
  const verdict = result.success ? 'EXITOSO ✅' : 'FALLIDO ❌';
  const durMs = duration_override_ms != null ? duration_override_ms : result.duration_ms;
  const mins = Math.floor(durMs / 60000);
  const secs = Math.floor((durMs % 60000) / 1000);
  const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const fmtVerif = (v) => {
    if (v === null) return '⏭️';
    return v ? '✅' : '❌';
  };

  const lines = [];
  lines.push(`## Build: ${verdict}`);
  lines.push('');
  lines.push('### Compilacion');
  lines.push(`- Modulo(s): ${result.modules.join(', ') || 'n/a'}`);
  lines.push(`- Resultado: ${result.success ? 'OK' : 'FALLO'}`);
  lines.push(`- Tiempo: ${durStr}`);
  lines.push(`- Scope: ${scope}${issue ? ` · issue #${issue}` : ''}`);
  lines.push(`- Tareas: ${result.tasks.executed} ejecutadas · ${result.tasks.up_to_date} up-to-date · ${result.tasks.from_cache} desde caché`);
  lines.push('');
  lines.push('### Verificaciones');
  lines.push(`- Strings legacy: ${fmtVerif(result.verifications.verifyNoLegacyStrings)}`);
  lines.push(`- Recursos Compose: ${fmtVerif(result.verifications.validateComposeResources)}`);
  lines.push(`- ASCII fallbacks: ${fmtVerif(result.verifications.scanNonAsciiFallbacks)}`);
  lines.push('');

  if (result.errors.length > 0) {
    lines.push('### Errores');
    for (const err of result.errors) {
      lines.push(`- **[${err.classification}]** ${err.task || '(sin task)'}`);
      if (err.fix) lines.push(`  - Fix sugerido: ${err.fix}`);
      if (err.escalate_to) lines.push(`  - Escalar a: \`${err.escalate_to}\``);
      const msgSnippet = (err.message || '').split('\n').slice(0, 5).join('\n  ');
      if (msgSnippet) lines.push(`  - Detalle:\n  \`\`\`\n  ${msgSnippet}\n  \`\`\``);
    }
    lines.push('');
  }

  lines.push('### Veredicto del Builder');
  lines.push(result.success
    ? 'Build exitoso — artefactos listos para la siguiente fase.'
    : 'Hay errores que corregir antes de continuar. Rebote al dev skill correspondiente.');

  return lines.join('\n');
}

module.exports = {
  parseGradleOutput,
  classifyError,
  renderMarkdownReport,
  ERROR_PATTERNS,
};
