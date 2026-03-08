# Cierre de sprint y planificación automática

> Documentación del flujo automático de cierre → propuesta → planificación → lanzamiento de sprint.
> Implementado en issue #1267.

---

## Visión general

Al cerrar un sprint, el sistema ejecuta un flujo completamente automático:

```
Sprint cierra
     │
     ▼
Stop-Agente.ps1 all ──────────────────── commit + PR + merge + cleanup
     │
     ▼
sprint-report.js ─────────────────────── reporte HTML+PDF → Telegram
     │
     ▼
planner-propose-interactive.js ───────── analiza codebase + propone historias
     │                                   presenta via Telegram con inline buttons
     │                                   espera N segundos (PropuestaTimeout)
     ▼
auto-plan-sprint.js ──────────────────── selecciona issues con priorización
     │                                   Técnico → QA → Negocio
     │                                   genera sprint-plan.json
     │                                   notifica via Telegram (Lanzar / Ver Plan)
     ▼
Usuario lanza Start-Agente.ps1 all ───── arrancan los nuevos agentes (max 2 simultáneos)
```

**El usuario solo interactúa en dos momentos:**
1. Aprobar/descartar propuestas de nuevas historias (botones Telegram)
2. Confirmar el lanzamiento del sprint (botón Telegram o PowerShell manual)

---

## Scripts involucrados

| Script | Rol |
|--------|-----|
| `scripts/detect-tech-debt.js` | Analiza el codebase en busca de deuda técnica |
| `scripts/planner-propose-interactive.js` | Genera propuestas + las presenta en Telegram |
| `scripts/auto-plan-sprint.js` | Planifica el sprint con priorización Técnico→QA→Negocio |
| `scripts/Watch-Agentes.ps1` | Orquesta el flujo completo al cierre |
| `.claude/hooks/telegram-commander.js` | Procesa callbacks de botones inline |
| `.claude/skills/planner/planning-criteria.md` | Criterios de priorización y scoring |

---

## Flujo de propuestas interactivas

### Cómo se generan las propuestas

`planner-propose-interactive.js` combina 4 fuentes de análisis:

1. **Deuda técnica** (`detect-tech-debt.js`):
   - TODOs/FIXMEs en código Kotlin/JS
   - Tests faltantes (ViewModels y clases de backend sin test)
   - Strings legacy (uso de `stringResource` fuera de `ResStrings`)
   - Fallos en reportes QA anteriores

2. **Extensiones naturales** (via `git log`):
   - Features implementadas (`feat(X):`) sin commits de test asociados
   - Commits marcados como WIP o incompletos

3. **Follow-ups de issues del sprint**:
   - Issues que mencionaron "pendiente", "futuro", "próximo sprint" en su body

4. **Propuestas estándar de mejora continua**:
   - Cobertura de tests (backend, ViewModels)
   - Auditoría de seguridad de logs
   - Consolidación de patrones de error

### Presentación en Telegram

Cada propuesta se muestra con:
```
⏳ 1. Título de la propuesta
   📏 M (2-3d) · 🏷 backlog-tecnico, enhancement
   Justificación breve (hasta 80 chars)

[✅ 1. Crear]  [❌ 1. Descartar]
```

Al final de la lista:
```
[✅ Crear todas las propuestas]
```

### Acciones disponibles

| Botón | Efecto |
|-------|--------|
| ✅ Crear | Lanza `/historia` para crear el issue en GitHub automáticamente |
| ❌ Descartar | Rechaza la propuesta; no se crea issue |
| ✅ Crear todas | Crea todas las propuestas pendientes en secuencia |

### Historial de propuestas

Las propuestas se almacenan en `scripts/.proposal-history.json`:

```json
{
  "history": [
    {
      "sprint": "2026-03-08",
      "date": "2026-03-08T15:00:00.000Z",
      "proposals": [
        {
          "title": "Agregar tests para LoginViewModel",
          "labels": ["backlog-tecnico", "testing"],
          "effort": "S",
          "source": "missing_test",
          "status": "created"
        }
      ]
    }
  ]
}
```

**Uso del historial:**
- Las propuestas descartadas en sprints anteriores **no se repiten** en sprints futuros
- Para revisar propuestas descartadas: `cat scripts/.proposal-history.json | jq '.history[-1]'`
- Para limpiar el historial (empezar de cero): eliminar el archivo

---

## Planificación automática con priorización

### Fases de selección

`auto-plan-sprint.js` selecciona issues en 3 fases estrictas:

#### Fase 1 — Backlog Técnico (primero siempre)

Issues con labels: `backlog-tecnico`, `tipo:infra`, `area:infra`, `blocker`

**Scoring bonus:** +30 pts sobre el scoring base de `planning-criteria.md`

**Justificación:** La salud del sistema (CI, pipeline, infra) tiene prioridad absoluta. Un problema de infra sin resolver afecta a todos los sprints futuros.

#### Fase 2 — QA/E2E Pendiente

Issues con labels: `qa-pending`, `needs-qa`, `testing`

O issues cuyo body menciona "QA E2E" o "validación qa".

**Justificación:** Issues mergeados sin validación QA tienen riesgo latente de regresiones.

#### Fase 3 — Backlog de Negocio

Issues con labels: `app:client`, `app:business`, `app:delivery`, `enhancement`, `feature`

**Justificación:** Las features de producto son el valor principal, pero solo después de asegurar la salud del sistema.

### Restricciones

| Parámetro | Valor por defecto | Configurable |
|-----------|-------------------|-------------|
| Máx issues por sprint | 5 | `--max N` |
| Máx agentes simultáneos | 2 | hardcoded |
| Issues bloqueados | excluidos | automático |

### Dependencias

El script detecta dependencias automáticamente en el body del issue:

- `depende de #NNN`
- `requiere #NNN`
- `bloqueado por #NNN`
- `depends on #NNN`

Un issue bloqueado por una dependencia **no incluida en el plan** es excluido.

### Estructura del sprint-plan.json generado

```json
{
  "fecha": "2026-03-15",
  "fechaFin": "2026-03-22",
  "generado_por": "auto-plan-sprint.js",
  "priorization": "Técnico → QA → Negocio",
  "max_issues": 5,
  "max_agents": 2,
  "total_selected": 4,
  "agentes": [
    { "numero": 1, "issue": 1267, "slug": "planner-propuesta-automatica", "stream": "Stream A — Backend/Infra" },
    { "numero": 2, "issue": 1280, "slug": "ci-fix-gradle", "stream": "Stream A — Backend/Infra" }
  ],
  "cola": [
    { "numero": 3, "issue": 1250, "slug": "test-coverage-backend", "stream": "Stream A — Backend/Infra" },
    { "numero": 4, "issue": 1260, "slug": "orders-screen", "stream": "Stream B — Cliente" }
  ]
}
```

**Nota:** `agentes` tiene máx 2 items (arrancados simultáneamente). `cola` tiene el resto, que `Watch-Agentes.ps1` activará en tandas de 2.

---

## Configuración en Watch-Agentes.ps1

### Parámetros

```powershell
.\Watch-Agentes.ps1                         # Flujo completo automático
.\Watch-Agentes.ps1 -PollInterval 60        # Polling cada 60s (default: 30)
.\Watch-Agentes.ps1 -SkipMerge             # PR sin merge automático
.\Watch-Agentes.ps1 -NoAutoPlan            # Deshabilitar flujo automático
.\Watch-Agentes.ps1 -PropuestaTimeout 300  # Esperar 5 min para aprobar propuestas
```

### PropuestaTimeout

Tiempo en segundos que el script espera **después de enviar las propuestas a Telegram** antes de continuar con la planificación automática. Default: 120 segundos (2 minutos).

Si el usuario necesita más tiempo para revisar las propuestas, usar `-PropuestaTimeout 300` o más.

Las propuestas **no se bloquean** esperando respuesta — si el usuario no responde a tiempo, las propuestas siguen en `planner-proposals.json` y el Commander las procesa cuando el usuario hace clic.

---

## Análisis de deuda técnica

`detect-tech-debt.js` detecta 6 tipos de deuda:

| Tipo | Descripción | Severidad |
|------|-------------|-----------|
| `todo` | TODOs/FIXMEs en código | high (FIXME) / medium (TODO) |
| `missing_test` | Archivos sin test correspondiente | medium |
| `legacy_string` | `stringResource` fuera de `ResStrings` | high |
| `qa_failure` | Fallos en reportes QA anteriores | high |
| `incomplete_refactor` | Commits WIP/temporal en git log | medium |
| `hardcoded_versions` | Versiones hardcodeadas en build.gradle | low |

### Uso manual

```bash
# Ver análisis en consola
node scripts/detect-tech-debt.js

# Output JSON (para integración)
node scripts/detect-tech-debt.js --json

# Limitar resultados
node scripts/detect-tech-debt.js --limit 10

# Dry-run de propuestas (sin Telegram)
node scripts/planner-propose-interactive.js --dry-run

# Dry-run de planificación (sin escribir sprint-plan.json)
node scripts/auto-plan-sprint.js --dry-run

# Planificación con máximo diferente
node scripts/auto-plan-sprint.js --max 3
```

---

## Handlers de Telegram

El `telegram-commander.js` procesa estos callbacks del flujo automático:

| callback_data | Acción |
|--------------|--------|
| `create_proposal:N` | Lanza `/historia` para crear el issue N |
| `discard_proposal:N` | Descarta la propuesta N |
| `create_all_proposals` | Crea todas las propuestas pendientes |
| `launch_sprint` | Notifica al usuario que ejecute `Start-Agente.ps1 all` |
| `view_sprint_plan` | Muestra el contenido de `sprint-plan.json` en Telegram |

---

## Personalización de priorización

Para cambiar el orden de fases (por ejemplo, priorizar QA sobre Técnico):

1. Editar `scripts/auto-plan-sprint.js` — función `selectIssues()`
2. Reordenar las secciones "Fase 1", "Fase 2", "Fase 3"
3. Ajustar los filtros de labels según el backlog del proyecto

Para cambiar el scoring de issues, editar `planning-criteria.md` — los valores de scoring se usan dentro de `auto-plan-sprint.js`.

---

## Troubleshooting

### Las propuestas no llegan a Telegram

1. Verificar que `telegram-commander.js` está corriendo: `node .claude/hooks/telegram-commander.js`
2. Verificar `telegram-config.json`: `cat .claude/hooks/telegram-config.json`
3. Revisar logs: `cat scripts/logs/planner-propose.log`

### auto-plan-sprint.js no selecciona issues

1. Verificar que `gh` CLI está autenticado: `gh auth status`
2. Verificar que hay issues abiertos con labels: `gh issue list --repo intrale/platform --state open`
3. Ejecutar con `--dry-run` para ver qué selecciona: `node scripts/auto-plan-sprint.js --dry-run`

### Las propuestas se repiten entre sprints

Las propuestas descartadas se guardan en `scripts/.proposal-history.json`. Si se corrompe o borra este archivo, las propuestas pueden repetirse. Para limpiar: `echo '{"history":[]}' > scripts/.proposal-history.json`

### Watch-Agentes.ps1 no ejecuta el flujo automático

Verificar que los scripts existen:
```powershell
Test-Path scripts/planner-propose-interactive.js
Test-Path scripts/auto-plan-sprint.js
```

Si no existen, el script hace fallback al comportamiento anterior (pregunta manual).
