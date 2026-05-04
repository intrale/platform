# QA — Templates de generacion (validate)

> Patrones completos para `validate <issue>`. El SKILL.md operativo referencia este doc en los pasos V3, V4 y V7.

---

## Template — Test API generado (Paso V3)

Para cada endpoint modificado/agregado en el diff, generar un archivo Kotlin en `qa/generated/api/` siguiendo este patron:

```kotlin
package ar.com.intrale.e2e.generated

import ar.com.intrale.e2e.QATestBase
import com.microsoft.playwright.options.RequestOptions
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import kotlin.test.assertTrue

@DisplayName("E2E Validate #<issue> — <endpoint> contra backend real")
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class Api<Endpoint>ValidateE2ETest : QATestBase() {

    @Test
    @Order(1)
    @DisplayName("POST /intrale/<endpoint> con datos validos responde 200")
    fun `<endpoint> happy path responde 200`() {
        val response = apiContext.post(
            "/intrale/<endpoint>",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(/* datos validos segun el issue */))
        )
        logger.info("<Endpoint> happy path: status=${response.status()}")
        assertTrue(response.status() in 200..299,
            "<Endpoint> con datos validos debe responder 2xx. Actual: ${response.status()}")
    }

    @Test
    @Order(2)
    @DisplayName("POST /intrale/<endpoint> sin body responde 400")
    fun `<endpoint> sin body responde 400`() {
        val response = apiContext.post(
            "/intrale/<endpoint>",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData("")
        )
        logger.info("<Endpoint> sin body: status=${response.status()}")
        assertTrue(response.status() in 400..499,
            "<Endpoint> sin body debe responder 4xx. Actual: ${response.status()}")
    }

    @Test
    @Order(3)
    @DisplayName("POST /intrale/<endpoint> sin token responde 401")
    fun `<endpoint> sin token responde 401`() {
        // Solo para SecuredFunction — omitir si es funcion publica
        val response = apiContext.post(
            "/intrale/<endpoint>",
            RequestOptions.create()
                .setHeader("Content-Type", "application/json")
                .setData(mapOf(/* datos validos */))
        )
        logger.info("<Endpoint> sin token: status=${response.status()}")
        assertTrue(response.status() in 400..499,
            "<Endpoint> sin token debe responder 4xx. Actual: ${response.status()}")
    }
}
```

### Reglas de generacion (API)

- Usar `Write` tool para crear cada archivo `.kt` en `qa/generated/api/`.
- Package: `ar.com.intrale.e2e.generated`.
- Clase extiende `QATestBase()` (reutiliza Playwright context).
- Nombre de clase: `Api<Endpoint>ValidateE2ETest`.
- Generar minimo: happy path (200), sin body (400), sin token (401) por endpoint.
- Adaptar datos del body segun lo que el diff muestra (clases de request, campos requeridos).
- Si el endpoint es `Function` (publica, no JWT): omitir test de "sin token".
- Si el endpoint es `SecuredFunction` (requiere JWT): incluir test de "sin token".

---

## Template — Flow Maestro generado (Paso V4)

Para cada pantalla/flujo modificado en el diff, generar un archivo YAML en `qa/generated/maestro/`:

```yaml
appId: com.intrale.app.client
---
# Flujo: Validacion #<issue> — <descripcion>
- launchApp
- waitForAnimationToEnd

# Navegacion al punto de entrada
- tapOn:
    text: "<texto de navegacion>"
    optional: true
- waitForAnimationToEnd

# Interaccion con la funcionalidad
- tapOn:
    id: "<testId del componente>"
- inputText: "<datos de prueba>"

# Verificacion
- assertVisible:
    text: "<texto esperado>"
```

### Reglas de generacion (Maestro)

- Usar `Write` tool para crear cada archivo `.yaml` en `qa/generated/maestro/`.
- Nombre: `validate-<issue>-<descripcion>.yaml`.
- Usar `id:` (testId) de los componentes Compose cuando esten disponibles en el diff.
- Si no hay testIds, usar `text:` con los labels visibles.
- Cada flow debe ser autocontenido (comienza con `launchApp`).

---

## Template — qa-report.json (Paso V7)

```json
{
  "issue_number": 0,
  "issue_title": "<titulo del issue>",
  "branch": "<branch actual>",
  "timestamp": "<ISO 8601>",
  "acceptance_criteria": ["criterio 1", "criterio 2"],
  "test_cases": [
    {
      "id": "tc-1",
      "criterion": "criterio 1",
      "type": "api",
      "file": "qa/generated/api/ApiXxxValidateE2ETest.kt",
      "tests": [
        { "name": "nombre del test", "result": "PASSED" }
      ]
    }
  ],
  "pre_existing_tests": { "executed": 0, "passed": 0, "failed": 0 },
  "generated_tests": { "executed": 0, "passed": 0, "failed": 0 },
  "evidence": {
    "videos": ["qa/evidence/<issue>/maestro-validate-<issue>.mp4"],
    "traces": [],
    "html_report": "qa/evidence/<issue>/api/index.html"
  },
  "verdict": "APROBADO|RECHAZADO",
  "verdict_reason": "Texto explicativo"
}
```

### Logica del veredicto

- `APROBADO` si: todos los tests generados pasan Y todos los tests pre-existentes pasan (regresion).
- `RECHAZADO` si: algun test generado falla O algun test pre-existente falla.
- Rellenar `test_cases` mapeando cada criterio de aceptacion al test que lo valida.
- Rellenar contadores `pre_existing_tests` y `generated_tests` parseando la salida del summarizer (`qa/scripts/qa-summarize-results.js --out`).
- Rellenar `evidence` con las rutas reales de los artefactos copiados.
- Si no hay videos (sin emulador), `evidence.videos` debe ser `[]`.
