# Separar QA-API de QA-Android (Capa 3) — Especificacion Tecnica

**Fecha:** 2026-04-09  
**Estado:** Aprobado por Leo  
**Contexto:** Estrategia de 5 Capas — Capa 3  
**Dependencia:** Capa 1 (Ventana QA) + Capa 2 (Pre-flight Checks)

---

## Problema

Hoy existe un unico camino para QA: `qa-android.sh`, que levanta emulador, instala APK,
corre Maestro, y graba video. Pero un issue que solo toca el backend (ej: endpoint nuevo,
fix en Lambda) no necesita nada de eso. Queda trabado esperando la ventana QA del emulador
cuando podria validarse en 30 segundos con requests HTTP.

## Solucion

Crear un segundo script **`qa-api.sh`** y hacer que el Pulpo rutee automaticamente cada
issue al script correcto segun sus labels.

## Tabla de ruteo (en el Pulpo)

| Labels del issue | Modo QA | Script | Necesita ventana QA |
|---|---|---|---|
| `app:client`, `app:business` o `app:delivery` | QA-Android | `qa-android.sh` | Si (emulador) |
| `area:backend` sin ningun `app:*` | QA-API | `qa-api.sh` | **No** |
| `area:infra`, `docs` sin `app:*` ni `area:backend` | Estructural | Validacion minima | **No** |

El ruteo se determina en `preflightQaChecks()` (Capa 2) que ya clasifica el issue. La Capa 3
extiende esa clasificacion para distinguir entre QA-API y validacion estructural.

## Auto-clasificacion inteligente de issues sin labels

Si un issue llega al pre-flight sin ningun label de ruteo (`app:*`, `area:backend`, `area:infra`,
`docs`), el Pulpo **no cae ciegamente en structural**. En su lugar:

1. **Lee titulo y body del issue** desde GitHub
2. **Matchea contra reglas de keywords** organizadas por categoria:
   - UI/Android: pantalla, compose, viewmodel, carrito, login, etc. → `app:client`
   - Backend/API: endpoint, lambda, cognito, ktor, jwt, etc. → `area:backend`
   - Infra: pipeline, hook, gradle, deploy, etc. → `area:infra`
   - Docs: documentacion, spec, guia, etc. → `docs`
3. **Gana la categoria con mas hits** (mas keywords encontradas)
4. **Asigna el label en GitHub** automaticamente, asi queda clasificado para siempre
5. **Invalida la cache** y re-lee los labels para continuar con el ruteo normal
6. **Notifica por Telegram** que el issue fue auto-clasificado

Si la auto-clasificacion no encuentra matches (issue con texto ambiguo), cae en `structural`
como fallback final y loguea la situacion para revision manual.

**Implementacion:** `autoClassifyIssue()` en `pulpo.js`, invocada desde `preflightQaChecks()`.

## Clasificacion extendida del issue

```
Labels del issue
  ├── tiene label de ruteo?
  │   ├── SI → usar label existente
  │   └── NO → autoClassifyIssue() → asignar label → re-leer
  │
  ├── tiene app:* → QA-Android (qa-android.sh)
  ├── tiene area:backend (sin app:*) → QA-API (qa-api.sh)
  └── otros (infra, docs, hooks) → Estructural (validacion minima por agente)
```

El campo `qaMode` en el resultado de `preflightQaChecks()` indica el modo:
- `"android"` — requiere emulador, APK, Maestro
- `"api"` — requiere backend vivo, NO emulador ni APK
- `"structural"` — no requiere infra externa

## Casos de prueba: responsabilidad de la etapa de definicion

Los casos de prueba NO son responsabilidad del agente QA. Son un artefacto de la etapa
de definicion del issue, donde intervienen `/doc`, `/po`, y `/qa`.

### Flujo correcto

1. **Etapa de definicion** → se generan casos de prueba basados en los criterios de
   aceptacion del issue. Quedan en `qa/test-cases/{issue}.json`
2. **Etapa de dev** → el desarrollador implementa sabiendo que se va a probar
3. **Etapa de QA** → `qa-api.sh` solo **consume** los casos de prueba existentes.
   Los ejecuta, genera evidencia, reporta resultados. No inventa tests.

### Formato del archivo de test cases

```json
[
  {
    "id": "TC-01",
    "title": "Descripcion del caso de prueba",
    "criteria": "Criterio de aceptacion que valida",
    "method": "POST",
    "endpoint": "/intrale/signin",
    "body": {"email": "test@test.com", "password": "Test1234!"},
    "expected_status": 200,
    "expected_body_contains": ["idToken"]
  }
]
```

### Fallback: test cases generados en QA

Si `qa/test-cases/{issue}.json` no existe cuando llega a QA, se generan automaticamente
como fallback. Hay dos niveles de fallback:

1. **Pre-flight del Pulpo (automatico):** antes de lanzar el agente QA, el pre-flight
   ejecuta `qa/scripts/qa-generate-test-cases.js` que lee los criterios de aceptacion
   del issue desde GitHub y genera los test cases. Esto ocurre sin consumir tokens.

2. **Agente QA (manual):** si el pre-flight no pudo generar los test cases (ej: error
   de GitHub, issue sin criterios), el agente QA los genera manualmente basandose en
   lo que lee del issue y del codigo.

En ambos casos se marcan con `"generated_at": "qa"` para que quede registro de que
faltaron en la etapa de definicion.

**IMPORTANTE:** Esto es un fallback para issues en estado intermedio que no pasaron por
la etapa de definicion. El flujo ideal es que se generen en definicion (/doc, /po, /qa).
La existencia de test cases con `"generated_at": "qa"` es un indicador de proceso incompleto.

### Script generador: qa-generate-test-cases.js

```bash
QA_ISSUE=2041 node qa/scripts/qa-generate-test-cases.js
```

- Lee criterios de aceptacion del issue desde GitHub
- Genera un test case por cada criterio
- Infiere metodo HTTP, endpoint, y status esperado del texto del criterio
- Si no encuentra criterios, genera un test case generico minimo
- Exit codes: 0 (generados), 1 (error), 2 (ya existen)

## Script qa-api.sh

### Responsabilidades

1. **Leer test cases** del issue desde `qa/test-cases/{issue}.json`
2. **Ejecutar cada caso** como request HTTP contra el backend
3. **Generar evidencia** por cada criterio de aceptacion (request, response, resultado)
4. **Producir reporte** JSON + texto con resultados por criterio
5. **Exit code** 0 si todos pasan, 1 si alguno falla

### Variables de entorno

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `QA_ISSUE` | (requerido) | Numero del issue a validar |
| `QA_BASE_URL` | `https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev` | URL base del backend |
| `QA_TEST_CASES_DIR` | `qa/test-cases` | Directorio de test cases |
| `QA_EVIDENCE_DIR` | `qa/evidence` | Directorio de evidencia |

### Flujo del script

```
1. Leer qa/test-cases/{issue}.json
   └── Si no existe → exit 2 (señal al agente para generar fallback)
2. Para cada test case:
   a. Ejecutar request HTTP (curl)
   b. Capturar: status, body, headers, tiempo de respuesta
   c. Comparar con expected_status y expected_body_contains
   d. Registrar resultado: PASS / FAIL con evidencia completa
3. Generar reporte:
   a. qa/evidence/{issue}/qa-api-report.json (detalle por test case)
   b. qa/evidence/{issue}/qa-api-summary.txt (resumen legible)
4. Exit code: 0 si todos PASS, 1 si alguno FAIL, 2 si faltan test cases
```

### Formato del reporte de evidencia

```json
{
  "issue": "2041",
  "mode": "qa-api",
  "timestamp": "2026-04-09T12:30:00Z",
  "base_url": "https://...",
  "results": [
    {
      "id": "TC-01",
      "title": "...",
      "criteria": "...",
      "status": "PASS",
      "request": {
        "method": "POST",
        "endpoint": "/intrale/signin",
        "body": {...}
      },
      "response": {
        "status": 200,
        "body": "...",
        "headers": {...},
        "time_ms": 342
      },
      "assertions": [
        {"type": "status", "expected": 200, "actual": 200, "pass": true},
        {"type": "body_contains", "expected": "idToken", "found": true, "pass": true}
      ]
    }
  ],
  "summary": {
    "total": 3,
    "passed": 3,
    "failed": 0,
    "duration_ms": 1200
  }
}
```

## Integracion en el Pulpo

### Cambios en preflightQaChecks()

El resultado ahora incluye `qaMode`:

```javascript
return {
  ok: true,
  result: 'pass',
  qaMode: 'api',         // NUEVO: 'android' | 'api' | 'structural'
  flavors: [],
  requiresEmulator: false
};
```

### Cambios en brazoLanzamiento()

Cuando el Pulpo lanza un agente QA, pasa `qaMode` como variable de entorno:

```javascript
// En lanzarAgenteClaude, si fase === 'verificacion':
env.QA_MODE = preflight.qaMode;  // 'android' | 'api' | 'structural'
env.QA_ISSUE = issue;
```

El agente QA (skill `qa`) lee `QA_MODE` y decide que script ejecutar:
- `android` → `qa-android.sh`
- `api` → `qa-api.sh`
- `structural` → validacion directa sin script externo

### Issues QA-API NO pasan por ventana QA

Esto es critico: los issues de QA-API se pueden procesar **inmediatamente** sin esperar
la ventana QA, porque no compiten por recursos del emulador. Esto reduce la cola de la
ventana y acelera el flujo general.

En el pre-flight, si `qaMode === 'api'`:
- Skip checks 2 (APK), 3 ya no se skippea (backend SI se necesita), 4 (emulador)
- Check 3 (backend responde) SI se ejecuta — es necesario para QA-API
- El issue puede lanzarse directamente sin ventana QA activa

## Tests Kotlin E2E existentes

Ya existen 20 tests Kotlin E2E en `qa/src/test/kotlin/ar/com/intrale/e2e/api/` que usan
Playwright para requests HTTP contra el backend real. Estos tests son la base para QA-API
de issues genericos. Para issues especificos, `qa-api.sh` ejecuta los test cases del issue.

La prioridad de ejecucion:
1. Test cases del issue (`qa/test-cases/{issue}.json`) — siempre primero
2. Tests Kotlin relacionados (si existen y el agente QA los identifica) — complementario

## Relacion con las 5 Capas

| Capa | Nombre | Estado |
|------|--------|--------|
| 1 | Ventanas de QA Exclusivas | **Implementado** — mergeado a main |
| 2 | Pre-Flight Checks en Pulpo | **Implementado** — mergeado a main |
| 3 | Separar QA-API de QA-Android | **Implementado** — mergeado a main |
| 4 | APK como Artefacto de Build | **Implementado** — integrado en Capa 1 |
| 5 | Evidencia con Degradacion Gradual | Pendiente de revision con Leo |

## Decisiones clave (registro)

- **2026-04-09:** Leo aprueba separar QA-API de QA-Android para no trabar issues backend
  esperando emulador.
- **2026-04-09:** Leo indica que las pruebas QA-API deben basarse en los criterios de
  aceptacion del issue, con evidencia por cada criterio.
- **2026-04-09:** Leo indica que los casos de prueba se generan en la etapa de definicion,
  no en QA. El agente QA solo los consume. Si faltan, genera como fallback con marca.
- **2026-04-09:** Leo indica que si los test cases no estan generados, se deben generar
  igual como fallback para no bloquear. Issues en estado intermedio no tienen definicion
  completa, pero el QA no debe trabarse por eso.
