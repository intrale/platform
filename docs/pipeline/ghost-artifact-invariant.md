# Ghost Artifact Invariant — Pipeline V2

> Issue origen: [#3638](https://github.com/intrale/platform/issues/3638)
> Defensa runtime original: [#2854](https://github.com/intrale/platform/issues/2854)
> Estado: estable a partir del merge de #3638.

## 1. Qué es un "ghost artifact"

Un *ghost artifact* es un archivo `.md`, `.txt` o `.json` que vive en una
carpeta operacional del pipeline (`.pipeline/definicion/**`,
`.pipeline/desarrollo/**`) **y NO es un marker de skill**.

### Markers válidos

El pipeline V2 usa nombres de archivo planos como contrato entre el
**Pulpo** (orquestador) y los **agentes**:

```
<issue_number>.<skill>
```

Ejemplos: `1732.po`, `3638.pipeline-dev`, `2441.guru`.

Reglas estructurales:

- **Exactamente 2 segmentos** separados por punto.
- El `skill` matchea `[a-z][a-z0-9-]*` (sin puntos, sin acentos, sin
  mayúsculas). La lista canónica vive en `.pipeline/config.yaml`
  (`skills_por_fase`).

### Artifacts auxiliares (no markers)

Junto a los markers, hay archivos *legítimos* pero **auxiliares** que
agentes y operadores producen como metadata:

| Sufijo            | Productor          | Significado                                            |
|-------------------|--------------------|--------------------------------------------------------|
| `.comment.md`     | PO/UX/Guru/Security/etc. | Criterios de aceptación o análisis técnico volcados a archivo. |
| `.guidance.txt`   | `/destrabar` (humano) | Texto de destrabe humano para `bloqueado-humano/`.    |
| `.reason.json`    | Pulpo / agentes    | Motivo de rechazo, error, o decisión operativa.        |

Estos archivos **NO son markers** y por lo tanto NO deben aparecer en los
listados que el Pulpo, el dashboard, `wave-state`, `human-block`, etc.,
arman a partir de `fs.readdirSync`. Si aparecen, el pipeline los toma como
"agentes fantasma" y rompe invariantes (el incidente histórico fue
2026-05-11 con `#3073.pipeline-dev.guidance.txt` levantando alerta falsa
en Telegram).

## 2. El invariant

> **Ningún archivo `.md`, `.txt`, `.json` no-marker debe vivir
> indefinidamente en una carpeta operacional sin un issue activo o sin
> `.work`/`.build`/marker correspondiente en la carpeta padre.**

Dos consecuencias:

1. **Runtime**: todo componente del pipeline JS que lea directorios
   operacionales debe filtrar artifacts auxiliares con
   `isMarkerArtifact()` (sino los toma como markers fantasma).
2. **Garbage collection**: los artifacts que queden huérfanos (issue
   CLOSED + sin actividad en la carpeta padre) deben archivarse —
   **nunca eliminarse** — a `.pipeline/archivado/ghost-<timestamp>/` y
   registrarse en el audit log JSONL.

## 3. Capas de defensa

```
┌──────────────────────────────────────────────────────────────────────┐
│  Capa 1 — Runtime filter (lib/marker-artifact.js)                    │
│  isMarkerArtifact(name) → true si es artifact, false si es marker.   │
│  Importado por: pulpo.js, dashboard.js, dashboard-slices.js,         │
│  human-block.js, wave-state.js, eta-markers.js, rebote-classifier.js │
└──────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  Capa 2 — Garbage collector (lib/ghost-artifact-cleaner.js)          │
│  Cada 6h + boot del pulpo. Modos: --dry-run (default) / --execute.   │
│  Lock cooperativo, fail-safe gh down, idempotente, audit JSONL.      │
└──────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  Capa 3 — Linter estructural (lib/ghost-artifact-lint.js)            │
│  Bloquea PRs que introduzcan fs.readdir(Sync) sobre carpetas         │
│  operacionales sin isMarkerArtifact cerca. Hook pre-commit + CI.     │
└──────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  Capa 4 — Dashboard widget (sección "Ghost artifacts")               │
│  Lee últimas 10 líneas del audit JSONL. ⚠ si hubo cleanup 24h.       │
│  ✅ si > 7 días sin actividad. XSS-safe (escapeHtml en todo campo).  │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Operación

### Comando manual (operador)

```bash
# Reporte sin tocar disco (default fail-safe):
node .pipeline/lib/ghost-artifact-cleaner.js --dry-run

# Archivar candidatos confirmados:
node .pipeline/lib/ghost-artifact-cleaner.js --execute
```

Salida CLI: 1 línea `[ghost-artifact] mode=... done: { scanned, candidates,
archived, skipped, errors, durationMs, bucket }`. Exit code `0` si OK,
`1` si hubo errores, `2` si crash interno.

### Cron automático

El boot de `pulpo.js` arranca el cleaner como `setTimeout(2min)` +
`setInterval(6h)`. Cualquier excepción se loguea (`WARN
[ghost-artifact]`) pero NO mata el pulpo.

### Audit log

Archivo: `.pipeline/audit/ghost-artifacts-cleanup.jsonl`
Formato: 1 línea JSON por evento.

```json
{"timestamp":"2026-05-29T13:39:43Z","action":"cleanup","file":"definicion/criterios/pendiente/3076.po.comment.md","reason":"orphaned (issue #3076 CLOSED)","archived_to":"archivado/ghost-20260529-133929/definicion/criterios/pendiente/3076.po.comment.md","context":"runOnce"}
```

`action` ∈ `{cleanup, no-op, skip, error}`:

- `cleanup`: archivo movido a `archivado/`.
- `no-op`: archivo ya fue archivado en una corrida previa (idempotencia).
- `skip`: archivo NO archivado por razón explícita (gh down, symlink,
  sibling activo, etc.).
- `error`: hubo un fallo durante el ciclo (no archivó nada).

## 5. Protocolo de recuperación

### Issue cerrado se reabre después del cleanup

1. Comprobar en `.pipeline/archivado/ghost-<timestamp>/` si hay archivos
   del issue (`grep -rl "<issue_number>." archivado/ghost-*/`).
2. Si los hay y son necesarios, copiar manualmente a la carpeta
   operacional correspondiente.
3. Documentar en el comentario del issue por qué se restauró.

### Falso positivo del linter

1. Verificar empíricamente que el path NO es operacional (ej. config,
   logs, tests, fixtures).
2. Agregar entry en `.pipeline/lib/ghost-artifact-lint.allowlist.json`
   con justificación específica:

```json
{
  "rules": [
    { "file": "lib/foo.js", "line": 42, "reason": "Lista assets de UX, no markers operacionales" }
  ]
}
```

3. Re-correr `node .pipeline/lib/ghost-artifact-lint.js --check`.

### Cleaner archiva por error un archivo necesario

1. El archivo está intacto en `.pipeline/archivado/ghost-<timestamp>/`.
2. Recuperarlo: `mv` al path original (la línea del audit log indica
   `file` y `archived_to`).
3. Si el bug es sistémico (regla de detección demasiado agresiva),
   abrir un issue con la entrada JSONL del falso positivo.

## 6. Limitaciones conocidas

- **TOCTOU `gh issue view` ↔ `renameSync`**: entre la verificación de
  estado del issue y el rename puede transcurrir un segundo. Si el issue
  se reabre exactamente en esa ventana, el archivo termina archivado.
  Recuperación manual: ver protocolo arriba.
- **Rotación del audit JSONL**: no implementada en este issue. Cuando
  el JSONL supera 10MB conviene rotar a `audit/archive/...`.
  Seguimiento: [#3645](https://github.com/intrale/platform/issues/3645).
- **Lint heurístico, no AST**: el linter usa regex pragmática. Es
  conservador (acepta `isMarkerArtifact*` cerca como evidencia válida)
  pero puede tener falsos positivos en casos sintácticamente atípicos.
  La allowlist resuelve esos casos.
- **Métricas de salud**: el widget muestra eventos recientes, no un
  gauge de tendencia (candidatos/semana, etc.). Seguimiento:
  [#3646](https://github.com/intrale/platform/issues/3646).

## 7. Trazabilidad técnica

| Componente | Archivo | CA |
|------------|---------|----|
| Filtro canónico | `.pipeline/lib/marker-artifact.js` | F-1 |
| Garbage collector | `.pipeline/lib/ghost-artifact-cleaner.js` | F-2..F-8, SEC-1..7, OPS-1..4 |
| Linter | `.pipeline/lib/ghost-artifact-lint.js` | F-9..F-11 |
| Hook pre-commit | `.husky/pre-commit` (suffix new) | F-11 |
| CI job | `.github/workflows/ghost-artifact-lint.yml` | SEC-8 |
| Widget dashboard | `dashboard.js` `renderGhostArtifactsWidget` | F-12, SEC-9 |
| Gitignore | `.gitignore` (`.pipeline/archivado/`, `.pipeline/audit/`) | SEC-6 |
| Tests | `.pipeline/lib/__tests__/marker-artifact.test.js`, `ghost-artifact-cleaner.test.js`, `ghost-artifact-lint.test.js` | F-10 |
| Allowlist | `.pipeline/lib/ghost-artifact-lint.allowlist.json` | F-11 |

## 8. Referencias

- [#3638](https://github.com/intrale/platform/issues/3638) — issue origen.
- [#2854](https://github.com/intrale/platform/issues/2854) — defensa runtime original.
- [#3518](https://github.com/intrale/platform/issues/3518) — `lib/file-lock.js`.
- [#3645](https://github.com/intrale/platform/issues/3645) — rotación del audit JSONL.
- [#3646](https://github.com/intrale/platform/issues/3646) — métricas de salud del FS operacional.
