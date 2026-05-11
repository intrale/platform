# Política de TOS / data residency / DPA por proveedor

> **Propósito**: documentar la política de cada proveedor LLM habilitado por el
> pipeline V3 multi-provider (#3065 §6.4) y la lista explícita de archivos del
> repo que **NO** se mandan a proveedores no-Anthropic.
>
> **Última verificación del relevamiento**: 2026-05-08
> **Autor**: pipeline-dev (issue #3084 / S6 multi-provider)
> **Sidecar de enforcement**: [`.pipeline/data-residency-exclusions.json`](../../.pipeline/data-residency-exclusions.json)
> **Schema validador**: [`.pipeline/data-residency-exclusions.schema.json`](../../.pipeline/data-residency-exclusions.schema.json)
> **Módulo de filtro**: [`.pipeline/lib/data-residency-filter.js`](../../.pipeline/lib/data-residency-filter.js)
> **Tests**: [`.pipeline/lib/__tests__/data-residency-filter.test.js`](../../.pipeline/lib/__tests__/data-residency-filter.test.js)

Esta política aplica solamente cuando hay **cambio de proveedor** (Política B
del épico #3065). Cross-MODELO dentro del mismo proveedor (Opus → Sonnet →
Haiku, etc.) no toca TOS/DPA — todos los modelos del mismo proveedor comparten
el mismo contrato.

## 1. Tabla de proveedores

La tabla cubre los proveedores **previstos** por el schema multi-provider
(`agent-models.schema.json` enum `launcher`: `claude`, `codex`, `gemini`,
`ollama`, `node`) y los modos de cuenta relevantes para Anthropic (API y Plan
Max). El estado de habilitación se cruza con `agent-models.json` (#3072 / H1).

| Provider | Habilitado en `agent-models.json` (2026-05-08) | Training opt-out por default | Región de procesamiento | BAA / DPA disponible | Retención logs lado proveedor | URL TOS | URL DPA | Última verificación |
|---|---|---|---|---|---|---|---|---|
| **Anthropic API** | ✅ sí (`anthropic`, default) | ✅ sí — no entrena con datos de la API | US (default), EU configurable | ✅ sí (Enterprise / Commercial Terms) | 30 días default; 0 días para clientes con Zero Data Retention | https://www.anthropic.com/legal/commercial-terms | https://www.anthropic.com/legal/dpa | 2026-05-08 |
| **Anthropic Plan Max** (cuenta Claude.ai consumidor) | ✅ sí (mismo `anthropic`) | ✅ sí en plan Pro/Max | US | ⛔ no aplica para cuentas de consumidor | n/a (sin retención de logs server-side) | https://www.anthropic.com/legal/consumer-terms | n/a | 2026-05-08 |
| **OpenAI API** (codex) | ❌ no — stub solo (#3076 / H3) | ⚙️ configurable — opt-out manual desde dashboard de la organización | US (default), EU opcional vía Data Residency | ✅ sí (Enterprise + DPA) | 30 días default | https://openai.com/policies/row-business-terms/ | https://openai.com/policies/data-processing-addendum/ | 2026-05-08 |
| **OpenAI tier free** | ❌ no | ⛔ NO — entrena con datos por default | US | ⛔ no | indefinido | https://openai.com/policies/row-terms-of-use/ | n/a | 2026-05-08 |
| **Google Gemini API** (paga) | ❌ no — schema lo permite, sin adapter | ⚙️ configurable — Vertex AI no entrena por default; Gemini API consumer sí | US/EU/global (Vertex) | ✅ sí (Vertex AI Enterprise / Workspace) | 30 días default (Vertex) | https://cloud.google.com/terms/service-terms | https://cloud.google.com/terms/data-processing-addendum | 2026-05-08 |
| **Google Gemini tier free** (Gemini API consumer) | ❌ no | ⛔ NO — entrena con datos por default en el tier free | US/global | ⛔ no | indefinido | https://ai.google.dev/gemini-api/terms | n/a | 2026-05-08 |
| **Ollama local** | ❌ no — schema lo permite, sin adapter | n/a — los datos no salen del host | localhost (no envía a servidor remoto) | n/a | local indefinido (gestionado por el operador) | https://ollama.com/library — TOS por modelo individual | n/a | 2026-05-08 |

> **Nota sobre habilitación**: la columna "Habilitado en `agent-models.json`"
> refleja el estado del archivo en `origin/main` al momento del último
> relevamiento. El schema permite enum de `launcher` (`claude`, `codex`,
> `gemini`, `ollama`, `node`) y de `output_parser` (`anthropic-stream-json`,
> `openai-sse`, `gemini-stream`, `ollama-jsonl`, `none`), pero los `providers`
> registrados son la fuente de verdad — sólo los listados en `providers` están
> activos.
>
> **OpenRouter** se menciona en el documento principal como capability futura
> pero no está en el enum del schema; no requiere fila hasta que se agregue.

## 2. Archivos NO enviados a proveedores no-Anthropic

Esta sección refleja la decisión documentada de §6.4 del épico multi-provider.
La lista vive como código en
[`.pipeline/data-residency-exclusions.json`](../../.pipeline/data-residency-exclusions.json)
(sidecar JSON validado por schema al boot del pulpo).

> **Nota operativa para el reviewer**: la lista de paths excluidos requiere
> validación final del operador (Leo) antes del merge — CA-2 del issue #3084.
> El reviewer humano confirma o ajusta la lista en el comentario del PR; el
> dev refleja la decisión final aplicando un commit fix antes del merge.

### 2.1 Categorización por sensibilidad

| Categoría | Patrones |
|---|---|
| **Secrets de runtime** (`.env`, application.conf) | `**/.env*`, `users/src/main/resources/application.conf`, `**/application.conf` |
| **Directorios convencionales de secrets** | `**/secrets/**`, `.pipeline/secrets/**` |
| **Credenciales de servicio** | `**/credentials`, `**/credentials.json` |
| **Material criptográfico privado** | `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.jks` |
| **Estado operacional del pipeline** | `.pipeline/quota-exhausted.json`, `.pipeline/audit/**`, `.pipeline/logs/env-allowlist-audit.log` |

### 2.2 Justificación por entrada

| Patrón | Motivo |
|---|---|
| `**/.env*` | archivos `.env` con secrets de runtime (AWS, Cognito, tokens) |
| `**/secrets/**` | directorio convencional de secrets en cualquier módulo |
| `.pipeline/secrets/**` | secrets del pipeline — no debería existir, defensa anti-hallazgo histórico |
| `users/src/main/resources/application.conf` | config de Lambda con secrets AWS y Cognito |
| `**/application.conf` | variantes de application.conf en otros módulos Ktor |
| `**/credentials` | archivos de credenciales sin extensión (estilo `~/.aws/credentials`) |
| `**/credentials.json` | credenciales de servicio (Google, AWS, etc.) |
| `**/*.pem` | claves criptográficas privadas en formato PEM |
| `**/*.key` | claves privadas (RSA / EC / etc.) |
| `**/*.p12` | keystores PKCS#12 con material privado |
| `**/*.jks` | Java keystores con material privado |
| `.pipeline/quota-exhausted.json` | estado operacional cross-provider — no se expone a un provider distinto del que lo generó |
| `.pipeline/audit/**` | audit logs internos del pipeline (incluye hash chains, switches de modelo, residencia, etc.) |
| `.pipeline/logs/env-allowlist-audit.log` | audit del allowlist de env vars (S7) — contiene hashes de keys del operador |

### 2.3 Granularidad por proveedor

Hoy todas las exclusiones aplican a la **categoría** `non_anthropic` — un único
bucket que cubre cualquier proveedor que NO sea `anthropic` ni `deterministic`.
El sidecar también permite listar nombres concretos de proveedor (ej.
`openai-codex`, `gemini`, `ollama`) en el campo `providers` de cada entrada,
para reglas más finas en el futuro.

Si en el futuro se identifica que un proveedor concreto cumple un BAA
suficientemente estricto como para relajar una exclusión específica, se cambia
el campo `providers` de esa entrada en el sidecar y se documenta acá.

## 3. Mecanismo de enforcement

El cumplimiento de esta política está implementado en
[`.pipeline/lib/data-residency-filter.js`](../../.pipeline/lib/data-residency-filter.js).

### 3.1 Boot del pulpo (fail-closed)

Al arrancar, el pulpo invoca `validateOrExit()` del módulo (igual que con
`agent-models-validate.js`). Si el sidecar no carga, no parsea o no valida,
el pulpo aborta el boot con `exit 2` (config inválida) y mensaje accionable
en español. **NO degrada silenciosamente a "sin filtro"**.

### 3.2 Llamada desde el lanzador del adapter no-Anthropic

```js
const filter = require('./lib/data-residency-filter');

// Boot.
const exclusions = filter.loadExclusionsOrThrow();

// Por cada lanzamiento de adapter no-Anthropic (futuro #3076 / H3 +).
const { allowed, blocked } = filter.filterPathsForProvider({
  paths: contextPaths,
  provider: 'openai-codex',
  exclusions: exclusions.exclusions,
  defaultPolicy: exclusions.default_policy,
});
if (blocked.length > 0) {
  filter.appendAudit({ skill, provider: 'openai-codex', blocked });
}
// Pasar `allowed` al adapter; abortar si quedó vacío y la política exige
// mínimo de contexto.
```

### 3.3 Audit log

`appendAudit()` escribe líneas JSONL en `.pipeline/audit/data-residency-filter.jsonl`
con shape:

```json
{"ts":"2026-05-08T03:00:00.000Z","skill":"review","provider":"openai-codex","path_hash":"a1b2c3d4e5f6","motivo":"archivos .env con secrets","pattern":"**/.env*"}
```

**Importante**: el `path_hash` es SHA-256 truncado a 12 hex del path crudo —
nunca se loguea el path original. Si el log mismo se filtra por error a un
canal con menor sensibilidad de retención, no queda expuesta la lista de
paths bloqueados (defensa profunda — el log de bloqueos no se vuelve un canal
secundario de leak).

El archivo se crea con permisos `0o600` (best-effort — Windows NTFS lo ignora,
POSIX lo respeta).

### 3.4 Anti path-traversal del sidecar

El schema [`data-residency-exclusions.schema.json`](../../.pipeline/data-residency-exclusions.schema.json)
rechaza, al boot:

- Patrones con prefijo absoluto (`/`, `\`).
- Patrones con prefijo `~/` (home).
- Patrones con segmento `..`.
- Patrones con `\\` (backslash literal escapado, vector Windows).
- Providers fuera del allowlist (cuando se invoca con `allowedProviders`).
- Entradas sin `motivo` o `motivo` muy corto (< 3 chars) o muy largo (> 200 chars).

La defensa es coherente con §6.10.1 del documento principal.

### 3.5 Independencia del sanitizer de logs (§6.5 / S2)

Este filtro y el sanitizer de output cumplen funciones distintas:

- **data-residency-filter** (este módulo): filtra **contexto que ENTRA** al
  modelo (paths que se le pasan al adapter). Defensa "input-side".
- **sanitize-log-stream** (#2334 / S2): filtra **output que SALE** al log
  (regex de API keys, tokens). Defensa "output-side".

Ninguno reemplaza al otro. Un agente Anthropic con env limpio igual debe
sanitizar su stdout/stderr porque el LLM puede generarlas por alucinación o
porque el operador las pegó en un prompt.

## 4. Verificación y tests

`.pipeline/lib/__tests__/data-residency-filter.test.js` cubre:

- **CA-4 #1**: path en exclusión no aparece en `allowed` (caso positivo).
- **CA-4 #2**: path fuera de exclusión sí aparece (anti falso-positivo).
- **CA-4 #3**: audit log persiste el shape esperado con `path_hash` (no path crudo).
- **CA-4 #3b**: `path_hash` es SHA-256 truncado a 12 hex (regresión).
- **CA-4 #3c**: `appendAudit` con `blocked` vacío no escribe el archivo.
- **CA-4 #4a**: sidecar ausente → `loadExclusionsOrThrow` lanza fail-closed.
- **CA-4 #4b**: sidecar con JSON inválido → fail-closed.
- **CA-4 #4c**: sidecar válido pero con `default_policy` faltante → fail-closed.
- **CA-4 #5**: provider `anthropic` → passthrough total.
- **CA-4 #5b**: provider `deterministic` → passthrough total.
- **CA-4 #6a/b/c/d**: patrones con `..`, `/`, `~/` → schema/compileGlob los rechazan.
- **CA-5**: `validateExclusionsSidecar` rechaza providers fuera del allowlist.
- **CA-5b**: providers en allowlist son aceptados.
- **Integración**: `loadExclusionsOrThrow` del sidecar canónico devuelve un shape consumible que incluye los candidatos de §6.4 (`.env`, `secrets`, `application.conf`).
- **`validateOrExit`**: sidecar válido no llama exit; sidecar ausente sí.

Ejecución:

```bash
node --test .pipeline/lib/__tests__/data-residency-filter.test.js
```

CLI standalone para validar el sidecar (pre-commit / reproducción manual):

```bash
node .pipeline/lib/data-residency-filter.js
```

## 5. Out of scope

Las siguientes capas viven en otros issues del épico multi-provider:

- Sanitizado de output a logs (#2334 / S2 — independiente, ver §3.5).
- Aislamiento de credenciales por env del child process (#3084 ya cerrado / S7).
- Audit log de switches de modelo (#3068 / §6.8.3).
- Adapters reales no-Anthropic (#3076 / H3 OpenAI codex; futuros para Gemini y
  Ollama). Hasta que existan, este filtro está activo pero **no tiene call
  sites no-Anthropic** — corre en boot validation (fail-closed) y queda listo
  para que H3+ lo invoque al construir el contexto del adapter.

## 6. Trazabilidad

- Issue origen: [#3084](https://github.com/intrale/platform/issues/3084) — S6 multi-provider.
- Documento principal: [`docs/pipeline-multi-provider.md`](../pipeline-multi-provider.md) §6.4.
- Dependencia bloqueante (resuelta): [#3072](https://github.com/intrale/platform/issues/3072) — H1.
