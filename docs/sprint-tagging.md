# Sprint Tagging y Releases Automáticas

> Convenciones de tags Git y sistema de releases automáticas para Intrale Platform.

## Convención de tags

| Tipo | Formato | Ejemplo | Cuándo |
|------|---------|---------|--------|
| Sprint | `sprint/YYYY-MM-DD` | `sprint/2026-03-14` | Siempre al cerrar un sprint |
| Release | `v*.*.*` (semver) | `v1.6.0` | Cuando el agente decide que hay masa crítica |

## Flujo automático

Al cerrar un sprint, `sprint-report.js` encadena automáticamente:

```
sprint-report.js
    ↓
sprint-tagger.js     ← Tag sprint/YYYY-MM-DD (SIEMPRE)
    ↓
evaluate-and-release.js  ← Evalúa autónomamente si crear release
    ↓
Telegram (informativo)
```

El proceso es **completamente automático** — no hay aprobación manual ni sugerencias. El agente decide y ejecuta.

## Tags de sprint

### Creación

```bash
# Se crea automáticamente via sprint-report.js
# No se ejecuta manualmente en operación normal
node scripts/sprint-tagger.js scripts/sprint-plan.json
```

### Formato del mensaje del tag

```
Sprint 2026-03-14 — cierre

Issues cerrados: #1258, #1257, #1259, #1260

## Features (2)
- #1258: pipeline: agregar /qa E2E
- #1254: Selección de tipografías por componente

## Infrastructure (2)
- #1264: timeout y cancelación automática de agentes
- #1262: docs: agregar /qa como gate obligatorio
```

### Consultar historial de sprint tags

```bash
# Listar todos los sprint tags (más reciente primero)
git tag -l 'sprint/*' --sort=-v:refname

# Ver mensaje de un tag específico
git show sprint/2026-03-14
```

## Releases automáticas

### Criterios de decisión (heurística del agente)

El agente evalúa los commits desde la última `v*.*.*` y aplica estas reglas:

| Condición | Tipo de release |
|-----------|----------------|
| 1+ breaking change en commits | `major` (vX.0.0) |
| 3+ features de producto (`feat:` commits) | `minor` (v0.X.0) |
| 5+ bugfixes acumulados (`fix:` commits) | `patch` (v0.0.X) |
| Solo infra/docs/refactor | **Sin release** |
| Menos de los mínimos | **Sin release** |

Los criterios están basados en [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `feat!:` para breaking).

### Historial de releases

```bash
# Listar todas las releases (más reciente primero)
git tag -l 'v*' --sort=-v:refname

# Ver changelog de una release
git show v1.6.0

# Ver cambios entre dos releases
git log v1.5.0..v1.6.0 --oneline
```

### Release history JSON

El archivo `.release-history.json` en la raíz del repo mantiene un registro de todas las releases creadas automáticamente:

```json
{
  "releases": [
    {
      "version": "v1.6.0",
      "date": "2026-03-14",
      "sprint": "SPR-001",
      "sprintTag": "sprint/2026-03-14",
      "type": "minor",
      "reason": "4 features de producto (mínimo 3 para release minor)",
      "commitsCount": 47,
      "lastRelease": "v1.5.0",
      "createdAt": "2026-03-14T18:30:00.000Z"
    }
  ]
}
```

## Rollback de tags

Si un tag fue creado por error:

```bash
# Eliminar tag local
git tag -d sprint/2026-03-14
git tag -d v1.6.0

# Eliminar tag remoto (CUIDADO: irreversible para otros que ya lo tengan)
git push origin --delete sprint/2026-03-14
git push origin --delete v1.6.0
```

> **Advertencia**: eliminar tags remotos afecta a todos los clones que ya los descargaron. Coordinar con el equipo antes de hacerlo.

## Scripts involucrados

| Script | Descripción |
|--------|-------------|
| `scripts/sprint-tagger.js` | Crea el tag `sprint/YYYY-MM-DD` con issues categorizados |
| `scripts/evaluate-and-release.js` | Evalúa heurística y crea release si corresponde |
| `scripts/sprint-report.js` | Orquestador — encadena ambos al final del reporte |

## Logs

Los logs de ejecución se guardan en:
- `scripts/logs/sprint-tagger.log`
- `scripts/logs/evaluate-release.log`

## Notificaciones Telegram

El sistema envía notificaciones **informativas** (no consultivas):

- **Sprint tag creado**: lista de issues y link al tag
- **Release creada**: versión, tipo, razón, commits
- **Sin release**: razón breve en 1-2 líneas

Las notificaciones no tienen botones de acción — el agente ya tomó la decisión.
