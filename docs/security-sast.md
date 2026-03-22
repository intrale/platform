# Pipeline SAST — Análisis de Seguridad Estático

## Descripción

El pipeline de seguridad estático (SAST) analiza el código fuente y sus dependencias en búsqueda de vulnerabilidades. Se ejecuta automáticamente en cada Pull Request.

> **Primera iteración: modo warning.** Los hallazgos de seguridad NO bloquean el merge. El objetivo es generar visibilidad sobre el estado de seguridad del proyecto.

## Herramientas integradas

### 1. OWASP Dependency Check

**Qué hace:** Escanea las dependencias del proyecto contra la base de datos [NVD (National Vulnerability Database)](https://nvd.nist.gov/) en búsqueda de CVEs conocidos.

**Configuración:**
- Plugin Gradle: `org.owasp.dependencycheck:12.2.0`
- `failBuildOnCVSS = 11.0` → nunca falla (CVSS máximo es 10.0)
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
        ├── OWASP Dependency Check ──→ Reporte HTML/JSON (artifact)
        │   (continue-on-error: true)
        │
        ├── Semgrep ─────────────────→ SARIF (Security tab) + artifact
        │   (continue-on-error: true)
        │
        ├── detect-secrets ──────────→ secrets-baseline.json (artifact)
        │   (continue-on-error: true)
        │
        └── sast-report ─────────────→ PR Comment con resumen consolidado
```

## Cómo ver los resultados

### En el PR

El job `sast-report` publica automáticamente un comentario sticky en el PR con:
- Estado de cada herramienta (✅ ok / ⚠️ hallazgos)
- Conteo de hallazgos de Semgrep y detect-secrets
- Links a los reportes completos

### Pestaña Security

Los hallazgos de Semgrep aparecen en: **Repositorio > Security > Code scanning alerts**

### Artifacts del workflow

Cada run del workflow guarda los reportes completos como artifacts (14 días de retención):
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

## Próximas iteraciones

- [ ] Activar modo bloqueante para vulnerabilidades críticas (CVSS ≥ 9.0)
- [ ] Configurar thresholds de `detect-secrets` por tipo de secreto
- [ ] Agregar análisis de licencias (`license-checker`)
- [ ] Integrar con Dependabot para auto-actualización de dependencias vulnerables
