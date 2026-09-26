# Pipeline SAST — Análisis de Seguridad Estático

## Descripción

El pipeline de seguridad estático (SAST) analiza el código fuente y sus dependencias en búsqueda de vulnerabilidades. Desde #7659 (decisión de #7658, filas 1, 3, 4 y 7) el análisis pesado **no corre en cada PR**: corre una vez por día sobre `main` y a demanda, y OWASP además corre en los PR que tocan dependencias.

### Qué corre cuándo

| Evento | Secret scan (blocking) | OWASP Dependency Check | Semgrep | detect-secrets | Resumen + aviso al operador |
|---|---|---|---|---|---|
| PR que **no** toca dependencias | ✅ bloquea | — | — | — | — |
| PR que toca dependencias (`gradle/libs.versions.toml`, `**/*.gradle.kts`, `buildSrc/**`) | ✅ bloquea | ✅ no bloquea (resultado en el summary del job) | — | — | — |
| Push a `main` | ✅ bloquea | — | — | — | — |
| Schedule diario (06:00 UTC / 03:00 ART) sobre `main` | — | ✅ | ✅ (SARIF a Security) | ✅ | ✅ |
| A demanda (`workflow_dispatch`, pestaña Actions → *Security SAST* → *Run workflow*) | — | ✅ | ✅ (SARIF a Security) | ✅ | ✅ |

> **Regla:** correr el workflow a demanda (`gh workflow run security-sast.yml --ref main`) **antes de cada release o deploy a Lambda**, y revisar el resumen antes de seguir.

> **Modo warning.** OWASP, Semgrep y detect-secrets NO bloquean el merge. El único control bloqueante del workflow es *Secret scan (blocking)*, que sigue corriendo en cada PR y en cada push a `main`.

### Riesgo aceptado: detección tardía

Aceptado por el operador en #7658 (fila 1, opción **b**):

- Una vulnerabilidad **nueva** publicada contra una dependencia que ya está en `main` se ve en la corrida diaria siguiente (hasta 1 día), no en un PR.
- Un hallazgo nuevo de Semgrep o detect-secrets introducido por un PR se ve en la corrida diaria siguiente, no en el PR.
- En un PR de dependencias con hallazgos de OWASP, el PR queda en verde (modo warning) y **no** se comenta: el rastro queda en el summary del job y en la corrida diaria. Darle veto sigue siendo alcance de #6610 / #5253.

## Herramientas integradas

### 1. OWASP Dependency Check

**Qué hace:** Escanea las dependencias del proyecto contra la base de datos [NVD (National Vulnerability Database)](https://nvd.nist.gov/) en búsqueda de CVEs conocidos.

**Configuración:**
- Plugin Gradle: `org.owasp.dependencycheck:12.2.0`
- `failBuildOnCVSS = 11.0` → nunca falla (CVSS máximo es 10.0)
- La variable `NVD_API_KEY`, cuando existe y no está vacía, se conecta a `dependencyCheck.nvd.apiKey` sin imprimirse ni persistirse.
- La credencial se declara en `jobs.dependency-check.env`, **no** en el `env:` de un step: el bloque `env:` de un step no está en scope para el `if:` de ese mismo step, así que declararla ahí haría que la condición leyera un contexto indefinido y se cumpliera siempre. Ese alcance de job es lo que permite consultar la *presencia* del secret desde un `if:` (el contexto `secrets` no está disponible en condiciones).
- La detección es **por presencia, nunca por valor**: sólo se compara `env.NVD_API_KEY` contra cadena vacía. No se usan `contains(...)`, prefijos, longitud ni hash, que convertirían el chequeo en un oráculo sobre el secret.
- La base NVD usa caches renovables `nvd-data-v2-<run_id>` y sólo restaura entradas del prefijo `nvd-data-v2-`; no recupera la cache `v1` histórica.
- Genera reportes en el directorio por defecto de Gradle

**Task Gradle:**
```bash
./gradlew dependencyCheckAggregate
```

**Reportes:** `build/reports/dependency-check/`

### 2. Semgrep

**Qué hace:** Análisis estático de código Kotlin/Java con patrones de seguridad predefinidos.

**Rulesets aplicados:**
- `p/kotlin` — Patrones específicos de Kotlin
- `p/java` — Patrones comunes de Java/JVM
- `p/secrets` — Detección de secretos en código
- `p/owasp-top-ten` — Vulnerabilidades OWASP Top 10

**Output:** SARIF → visible en la pestaña **Security > Code scanning** del repositorio.

### 3. detect-secrets

**Qué hace:** Detecta posibles secretos hardcodeados (API keys, tokens, contraseñas, etc.) en el código fuente.

**Archivos excluidos:**
- `.gradle/` — Caché de Gradle
- `build/` — Archivos compilados
- `.git/` — Historia de git
- `gradle/wrapper/` — Archivos del wrapper

## Flujo del pipeline

```
PR abierto/actualizado
        │
        ├── secret-scan ─────────────→ Secret scan (blocking) — frena el PR
        │
        └── detect-deps ──¿toca dependencias?──sí──→ OWASP Dependency Check
                                               │     (continue-on-error: true,
                                               │      conteos en el step summary)
                                               └─no─→ (nada más)

Push a main ─────────────────────────→ secret-scan (blocking)

Schedule diario / workflow_dispatch (sobre main)
        │
        ├── OWASP Dependency Check ──→ Reporte HTML (artifact, 7 días)
        ├── Semgrep ─────────────────→ SARIF (Security tab) + artifact (7 días)
        ├── detect-secrets ──────────→ secrets-baseline.json (artifact, 7 días)
        │
        └── sast-summary ────────────→ Resumen en el step summary
                                       + aviso al operador por Telegram
                                         (sólo si hay hallazgos o algo no terminó)
```

`concurrency` con `cancel-in-progress` va **a nivel job** y sólo en los tres escaneos pesados, cada uno con su grupo (el de OWASP incluye el evento, para que la corrida de un PR no cancele la diaria). Nunca a nivel workflow: cancelaría el *Secret scan* de dos pushes seguidos a `main`. Tampoco se usa `paths:` en `on.pull_request`: dejaría sin *Secret scan* a los PR que no tocan dependencias; el filtro lo hace el job `detect-deps` con `git diff` (sin API ni actions de terceros, y ante la duda corre OWASP).

## Cómo ver los resultados

> Ya **no** se publica un comentario en el PR (fila 7 de #7658): el repo es público y el comentario exponía el resumen a cualquiera.

### Resumen de la corrida (step summary)

El job `sast-summary` (*Resumen SAST*) escribe en la página del run:

- Un veredicto de una línea: `✅ Sin hallazgos`, `⚠️ N hallazgos` o `⚠️ Corrida incompleta: no terminó <herramienta>`. Si una herramienta falló, lo dice: nunca muestra un cero que no midió.
- Una tabla con conteos por herramienta (OWASP: vulnerabilidades y dependencias vulnerables; Semgrep: por nivel; detect-secrets: candidatos).
- Links a la pestaña Security y a los artefactos del run.

Nunca incluye CVE, paquete, versión ni `archivo:línea`.

### Aviso al operador (Telegram)

Si la corrida diaria o a demanda encuentra hallazgos o alguna herramienta no terminó, `sast-summary` manda un mensaje en español al Telegram del operador, con audio (voz `es-AR-TomasNeural`), sólo con conteos y el link a la pestaña Security. Si el audio falla, el texto sale igual y el run deja un `::warning`.

Requiere los secrets `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en el repo. **Hoy no están cargados** (`gh secret list` sólo lista los de Firebase y, cuando exista, `NVD_API_KEY`): mientras falten, el step no falla y el resumen dice `Aviso al operador: no enviado, el canal privado no está configurado`. Para darlos de alta sin imprimirlos:

```bash
gh secret set TELEGRAM_BOT_TOKEN --repo intrale/platform   # pegar el valor cuando lo pida
gh secret set TELEGRAM_CHAT_ID --repo intrale/platform
```

### Pestaña Security

Los hallazgos de Semgrep aparecen en: **Repositorio > Security > Code scanning alerts** (visible sólo con permisos del repo). Se actualiza con la corrida diaria.

### Artifacts del workflow

Cada corrida guarda los reportes completos como artifacts con **7 días de retención**. El repo es público: cualquier usuario autenticado de GitHub puede bajarlos, así que se asumen públicos durante esa semana.
- `owasp-dependency-check-report/` — Reporte HTML navegable
- `semgrep-sarif/` — Archivo SARIF de Semgrep
- `secrets-baseline/` — Baseline de detect-secrets

## Gestión de falsos positivos

### OWASP Dependency Check

Editar `dependency-check-suppressions.xml` para suprimir CVEs evaluados y aceptados:

```xml
<suppressions xmlns="https://jeremylong.github.io/DependencyCheck/dependency-suppression.1.3.xsd">
  <suppress>
    <notes>Evaluado 2026-03-22: no aplica a este uso de la librería</notes>
    <cve>CVE-XXXX-YYYY</cve>
  </suppress>
</suppressions>
```

### detect-secrets

Si un archivo tiene un falso positivo, agregar un comentario en línea:
```
# pragma: allowlist secret
```

## Variables de entorno opcionales

| Variable | Descripción | Dónde configurar |
|----------|-------------|-----------------|
| `NVD_API_KEY` | API key de NVD para evitar rate limiting en OWASP DC | GitHub Secrets |

> Sin `NVD_API_KEY`, el scan puede ser más lento o fallar por rate limiting de NVD. Para obtener una key gratuita: https://nvd.nist.gov/developers/request-an-api-key

### Alta manual de `NVD_API_KEY`

> **Bloqueo humano explícito: [#6391](https://github.com/intrale/platform/issues/6391)** (`needs-human`, OPEN).
> El secret **no está aprovisionado**: `gh secret list` sólo devuelve los cinco secrets de Firebase.
> El alta y la medición de las tres corridas consecutivas viven en #6391, no en #6362.
> Hasta que #6391 cierre, el job corre por la rama de credencial ausente y lo declara en el summary.

El secret todavía requiere una acción humana porque NVD confirma el alta por correo:

1. Solicitar una API key en https://nvd.nist.gov/developers/request-an-api-key y completar la confirmación recibida por correo.
2. Cargarla sin imprimirla: `gh secret set NVD_API_KEY --repo intrale/platform` y pegar el valor cuando `gh` lo solicite.
3. Comprobar únicamente su presencia con `gh secret list --repo intrale/platform`; el comando debe listar `NVD_API_KEY`.

### Estado de la credencial en el summary del workflow

El job declara el estado de la credencial en **ambas** ramas, nunca en silencio y nunca interpolando el valor:

| Situación | Línea en `$GITHUB_STEP_SUMMARY` |
|-----------|---------------------------------|
| Secret ausente (`env.NVD_API_KEY == ''`) | `Estado de credencial: API key del NVD no disponible.` + aviso de mayor duración por rate limit anónimo |
| Secret presente (`env.NVD_API_KEY != ''`) | `Estado de credencial: API key del NVD disponible.` |

El encabezado `## OWASP Dependency Check` lo emite un step **sin `if:`** ubicado **antes** de ambas ramas: `$GITHUB_STEP_SUMMARY` es append-only en orden de ejecución, así que un encabezado dentro de un step condicional dejaría huérfanas las líneas `Estado del reporte: …` cuando esa rama no corre.

Los pull requests desde forks no reciben secrets. En ese caso el workflow continúa en modo warning, informa que la API key no está disponible y anticipa la mayor duración, sin mostrar el valor. El reporte consolidado diferencia estos estados textuales:

- `scan válido`: la task terminó correctamente y existe un reporte OWASP.
- `scan fallido`: la task terminó con error; que el modo warning no bloquee el merge no significa que el scanner haya funcionado.
- `reporte ausente`: la task no dejó un reporte verificable y no se interpreta como ausencia de vulnerabilidades.

## Próximas iteraciones

- [ ] Activar modo bloqueante para vulnerabilidades críticas (CVSS ≥ 9.0)
- [ ] Configurar thresholds de `detect-secrets` por tipo de secreto
- [ ] Agregar análisis de licencias (`license-checker`)
- [ ] Integrar con Dependabot para auto-actualización de dependencias vulnerables
