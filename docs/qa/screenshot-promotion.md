# Hook QA — Promoción de screenshots a librería curada

> **Issue origen**: [#3409](https://github.com/intrale/platform/issues/3409) (split 3/3 de [#3382](https://github.com/intrale/platform/issues/3382)).
> **Implementación**: [`qa/scripts/promote-screenshots.js`](../../qa/scripts/promote-screenshots.js).
> **Skill que lo invoca**: [`.claude/skills/qa/SKILL.md`](../../.claude/skills/qa/SKILL.md) — Paso V7c.
> **Librería destino**: [`docs/app-screenshots-reference/`](../app-screenshots-reference/) (entregada por [#3407](https://github.com/intrale/platform/issues/3407)).
> **Doc operativa del flujo paraguas**: [`docs/pipeline/ux-android-visual-flow.md`](../pipeline/ux-android-visual-flow.md).

Este documento describe el hook QA que, al cierre de un `/qa validate <issue>`
con veredicto APROBADO, promueve los screenshots representativos a la librería
canónica para uso cross-agente (UX en definición, dev en implementación, QA
en validación visual post-build).

## 1. Cuándo se ejecuta

El hook corre como **Paso V7c** del skill `/qa` (`flujo de validacion`),
después de:

1. `Paso V7` — generación de `qa/evidence/<issue>/qa-report.json`.
2. Verificar que `qa-report.verdict === "APROBADO"`.
3. El issue tiene al menos un label `app:client | app:business | app:delivery`.

Si alguna condición falla, el hook NO se invoca. El propio hook re-verifica el
verdict del report como guarda defensiva.

## 2. Contrato CLI

```bash
node qa/scripts/promote-screenshots.js \
  --issue <N> \
  [--evidence-dir <path>] \
  [--library-dir <path>] \
  [--report <path>] \
  [--flavor <client|business|delivery>] \
  [--date <YYYY-MM-DD>] \
  [--dry-run]
```

| Flag             | Default                                          | Notas                                    |
|------------------|--------------------------------------------------|------------------------------------------|
| `--issue`        | (obligatorio)                                    | Número de issue del run QA              |
| `--evidence-dir` | `qa/evidence/<issue>/`                           | Directorio con los PNGs a evaluar       |
| `--library-dir`  | `docs/app-screenshots-reference/`                | Librería destino                        |
| `--report`       | `<evidence-dir>/qa-report.json`                  | Para leer verdict/flavor/labels         |
| `--flavor`       | (inferido de report)                             | Override explícito si el report no lo expone |
| `--date`         | UTC hoy `YYYY-MM-DD`                             | Para la fecha del filename canónico     |
| `--dry-run`      | `false`                                          | Loguea acciones, no copia archivos      |

**Importante**: el path del módulo PII (`qa/lib/pii-policy.js`) **NO es
configurable** ni por CLI ni por env. Es fijo por diseño (CA-7.8) para que un
dev distraído no pueda bypassear el fail-safe.

## 3. Lógica de promoción

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 1. ensureLibraryPresent(libraryDir)                                      │
│    └─ si NO existe → exit 1 con "screenshots-reference library missing"  │
│ 2. readQaReport(reportPath)                                              │
│    └─ si verdict ≠ APROBADO → exit 0 con skip                            │
│ 3. loadPIIPolicy(qa/lib/pii-policy.js)                                   │
│    └─ si no disponible → exit 0 con "PII policy unavailable"             │
│ 4. resolveFlavor(--flavor || report.flavor || único label app:*)         │
│    └─ si no se resuelve → exit 0 con "flavor not resolved"               │
│ 5. listEvidencePngs(evidenceDir)                                         │
│ 6. Para cada PNG:                                                        │
│      a. inferScreen(filename) — heurística de mapeo                      │
│      b. policy.hasPII(file, {issue, flavor, screen})                     │
│      c. if pii.flagged → log "PII detected" + skip                       │
│      d. computeTargetPath(<pantalla>/<pantalla>-<flavor>-<fecha>.png)    │
│      e. if existsSync(target) && sha256(target) === sha256(src)          │
│           → log "already in library" + skip (idempotencia)               │
│      f. atomicCopy(src, target) — tmp+rename para no dejar parciales     │
│      g. if willOverwrite → log "overwritten same-day screenshot"         │
│ 7. Resumen final accionable: "promoted N screenshots to library"         │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. Comportamiento fail-safe (CA-7.7 + CA-7.8)

El repo `intrale/platform` es **público**. La política por defecto es:
**si no se puede confirmar que un screenshot está libre de PII → NO se
promueve**.

| Situación                                                | Acción                                          |
|----------------------------------------------------------|-------------------------------------------------|
| `qa/lib/pii-policy.js` no existe                         | Exit 0, log `PII policy unavailable`           |
| `qa/lib/pii-policy.js` lanza al cargar                   | Exit 0, log `PII policy unavailable`           |
| `qa/lib/pii-policy.js` no exporta `hasPII`               | Exit 0, log `PII policy unavailable`           |
| `policy.hasPII()` lanza para un PNG específico           | Skip ese PNG, log con error message            |
| `policy.hasPII()` devuelve `{ flagged: true, flags: [] }`| Skip ese PNG, log `PII detected — skipped`     |

Notas operativas:

- Hasta que [#3385](https://github.com/intrale/platform/issues/3385) entregue
  el módulo `qa/lib/pii-policy.js` con su política formal, el hook **no
  promueve nada en producción** y solo loguea la causa.
- En tests, los fixtures escriben un `qa/lib/pii-policy.js` sintético dentro
  del directorio temp del test (no toca el repo real).

## 5. Contrato esperado del módulo PII (`qa/lib/pii-policy.js`)

A entregar por [#3385](https://github.com/intrale/platform/issues/3385):

```js
// qa/lib/pii-policy.js
module.exports = {
    /**
     * Determina si un screenshot contiene PII visible.
     *
     * @param {string} filePath - Path absoluto al PNG.
     * @param {{issue: string|number, flavor: string, screen: string}} context
     * @returns {{ flagged: boolean, flags?: string[] }}
     */
    hasPII(filePath, context) {
        // implementación: OCR + regex contra patrones sensibles,
        // o consulta a un manifest declarativo.
        return { flagged: false, flags: [] };
    },
};
```

Reglas:

- **Síncrono**. El hook QA no maneja promesas.
- **Defensivo**: si lanza, el hook trata el PNG como "PII no determinable" y
  lo skippea (no promueve).
- **Idempotente**: la respuesta no puede depender del orden de llamada.

## 6. Heurística filename → pantalla canónica

Alineada con [`docs/pipeline/ux-android-visual-flow.md`](../pipeline/ux-android-visual-flow.md) §7.
El orden de chequeo importa: reglas más específicas primero.

| Substring (case-insensitive)            | Pantalla canónica   |
|-----------------------------------------|---------------------|
| `password-recovery`, `recovery`         | `login`             |
| `signin`, `login`                       | `login`             |
| `signup`, `register`, `registro`        | `signup`            |
| `welcome`                               | `welcome`           |
| `business-home`, `home`, `^main`, `-main` | `home`            |
| `drawer-search`, `busqueda`, `búsqueda`, `search` | `busqueda` |
| `detalle-producto`, `product-detail`, `producto`, `detalle`, `product` | `detalle-producto` |
| `carrito`, `cart`                       | `carrito`           |
| `checkout`                              | `checkout`          |
| `profile-selector`, `perfil`, `profile` | `perfil`            |
| `pedidos`, `pedido`, `orders`, `order`  | `pedidos`           |

Si **ningún** patrón matchea, el PNG queda como `skipped_unmapped` y el hook
loguea `unmapped: <filename>` pero continúa con el resto. La recomendación
[#3466](https://github.com/intrale/platform/issues/3466) propone un schema
declarativo `qa/screenshot-mapping.yaml` que reemplaza esta heurística
implícita.

## 7. Resolución de flavor

Orden de precedencia:

1. `--flavor <client|business|delivery>` (CLI explícito).
2. `qa-report.flavor` si el report lo expone (a entregar por [#3468](https://github.com/intrale/platform/issues/3468)).
3. Si `qa-report.labels` tiene **exactamente un** label `app:*` → ese flavor.
4. Si hay varios `app:*` y no hay override → skip con log `flavor not resolved`.

Hasta que #3468 cierre, lo más probable es que el hook deba recibir
`--flavor` explícito desde el invocador (skill `/qa`).

## 8. Idempotencia

El hook compara sha256 del PNG origen contra el destino existente (mismo
filename canónico). Tres escenarios:

| Estado destino                    | Acción                                |
|-----------------------------------|---------------------------------------|
| No existe                         | Copia atómica (tmp + rename)          |
| Existe con **mismo** hash         | Skip (`already in library`)           |
| Existe con **distinto** hash      | Sobreescribe (`overwritten same-day…`)|

La copia se hace con `tmp+rename` para no dejar archivos parcialmente
escritos si el proceso muere a mitad. La recomendación
[#3467](https://github.com/intrale/platform/issues/3467) trackea formalizar
esta atomicidad como un helper reusable.

## 9. Códigos de salida

| Exit code | Significado                                                           |
|-----------|-----------------------------------------------------------------------|
| 0         | Ejecución concluida (incluye fail-safe sin promoción)                |
| 1         | Error duro (librería ausente, qa-report ilegible, copia fallida)     |
| 2         | Argumentos inválidos                                                  |

El hook **no aborta** el QA aunque skippee toda la promoción: el QA sigue su
flujo normal después de V7c.

## 10. Tests

Cobertura en [`qa/scripts/__tests__/promote-screenshots.test.js`](../../qa/scripts/__tests__/promote-screenshots.test.js):

1. **Escenario 1 (Gherkin PO)** — QA exitoso promueve login + carrito.
2. **Escenario 2 (Gherkin PO)** — Idempotente (no duplica al re-ejecutar).
3. **Escenario 3 (Gherkin PO)** — Sobreescribe versión anterior del mismo día.
4. **Escenario 4 (Gherkin PO)** — PII detectada → skip con log.
5. **Escenario 5 (Gherkin PO)** — Política PII no disponible → fail-safe.
6. **Escenario 6 (Gherkin PO)** — Librería ausente → error claro con ref a #3407.

Más escenarios defensivos (módulo PII con contrato roto, `hasPII` lanza,
RECHAZADO no promueve, flavor irresoluble, heurística de mapeo, etc.).

Ejecutar localmente:

```bash
node --test qa/scripts/__tests__/promote-screenshots.test.js
```

O via npm (junto al resto de tests del pipeline):

```bash
npm run test:pipeline
```

## 11. Limitaciones conocidas / issues relacionados

| Issue                                                            | Relación                                                |
|------------------------------------------------------------------|---------------------------------------------------------|
| [#3385](https://github.com/intrale/platform/issues/3385)         | Política PII formal — el hook no promueve sin ella     |
| [#3407](https://github.com/intrale/platform/issues/3407)         | Estructura `docs/app-screenshots-reference/` (mergeado)|
| [#3408](https://github.com/intrale/platform/issues/3408)         | Helpers UX para consumir la librería desde definición  |
| [#3459](https://github.com/intrale/platform/issues/3459)         | Path sanitization adicional (recomendación)            |
| [#3460](https://github.com/intrale/platform/issues/3460)         | EXIF/metadata stripping antes de promover              |
| [#3461](https://github.com/intrale/platform/issues/3461)         | Caps de tamaño/cantidad por run                        |
| [#3466](https://github.com/intrale/platform/issues/3466)         | Schema declarativo `qa/screenshot-mapping.yaml`        |
| [#3467](https://github.com/intrale/platform/issues/3467)         | Atomicidad (tmp+rename) como helper reusable           |
| [#3468](https://github.com/intrale/platform/issues/3468)         | Exponer flavor en `qa-report.json`                     |

Ninguna bloquea la operatividad actual: el hook es funcional hoy con
comportamiento fail-safe ante cualquier ausencia.
