# Ventana de QA Exclusiva — Especificacion Tecnica

**Fecha:** 2026-04-09  
**Estado:** Aprobado por Leo (pendiente implementacion)  
**Contexto:** Estrategia de 5 Capas para solucion definitiva del agente QA

---

## Concepto

Cuando se acumulan issues pendientes de QA E2E, el pipeline entra en **modo exclusivo de QA**.
Durante este modo, se pausan las fases de dev y build para liberar recursos (CPU, RAM) y
garantizar que el emulador Android y Maestro corran sin contension.

## Por que pausar dev Y build

| Fase    | Consumo tipico              | Conflicto con QA                    |
|---------|-----------------------------|--------------------------------------|
| **Dev** | Claude API (CPU moderado)   | Compite por tokens y escritura disco |
| **Build** | Gradle ~4GB heap + CPU 100% | OOM si corre en paralelo con emulador |
| **QA**  | Emulador + Maestro + edge-tts | Necesita CPU y RAM exclusivos        |

**Regla:** dev y build paralelizados con QA "hacen desastre" (cita Leo, 2026-04-09).

## Flujo de la Ventana QA

```
1. Pulpo detecta: issues con fase QA pendiente >= 1
2. Pulpo escribe priority-windows.json:
   { "qa": { "active": true }, "build": { "active": true } }
3. Pulpo NO lanza nuevos agentes dev ni build
4. Agentes dev/build en curso terminan su paso actual (no se matan)
5. Verificar APK disponible para cada issue en cola:
   a. Buscar en qa/artifacts/{issue}-composeApp-{flavor}-debug.apk
   b. Si falta: rechazar issue con motivo "APK faltante", re-encolar para build
   c. Solo procesar issues que tengan su APK listo
6. **La ventana (Pulpo) levanta el emulador** con snapshot qa-ready (~40s boot)
7. Ejecutar QA issues en serie (un solo boot, N issues, cada uno con su APK)
8. Al vaciar cola QA:
   a. **La ventana (Pulpo) apaga el emulador**
   b. Escribir priority-windows.json: qa.active=false, build.active=false
   c. Pipeline reanuda dev y build normalmente
```

## Responsabilidad del emulador (CRITICO)

El **agente de QA no debe levantar ni apagar el emulador**. Esa es responsabilidad
exclusiva de la **ventana de QA** (gestionada por el Pulpo). El agente de QA asume
que el emulador ya esta corriendo cuando le toca ejecutar.

**Razon:** si el agente de QA intentara levantar el emulador por su cuenta, podria
hacerlo en un momento donde los recursos estan ocupados por dev o build, causando
los mismos problemas que motivaron las ventanas exclusivas. La orquestacion del
emulador queda centralizada en el Pulpo para garantizar que solo se prende cuando
los recursos estan liberados.

**Flujo del agente QA:**
1. Recibe un issue para validar
2. Verifica si el emulador esta disponible (via `adb devices`)
3. Si esta disponible → procede con la validacion
4. Si NO esta disponible → **no intenta levantarlo**, reporta que el emulador no
   esta listo y el Pulpo re-encola el issue para la proxima ventana QA

## APK como artefacto de build (por issue)

La generacion del APK es **responsabilidad de la fase de build de cada issue**, no de la ventana QA.
Cada issue produce su propio APK porque el codigo cambia entre issues.

### Convencion de nombrado

```
qa/artifacts/{issue}-composeApp-{flavor}-debug.apk
```

Ejemplo: `qa/artifacts/2041-composeApp-delivery-debug.apk`

### Flujo de generacion (en fase build del issue)

1. El agente de build determina el flavor segun labels del issue
2. Compila el APK con el codigo del worktree/rama del issue
3. Copia el APK a `qa/artifacts/{issue}-composeApp-{flavor}-debug.apk`
4. Si el issue tiene multiples labels `app:*`, genera un APK por flavor

### Flavors y sus builds

| Flavor   | Build command                                          | APK output path                                    |
|----------|--------------------------------------------------------|-----------------------------------------------------|
| client   | `./gradlew :app:composeApp:assembleClientDebug`        | `app/composeApp/build/outputs/apk/client/debug/`    |
| business | `./gradlew :app:composeApp:assembleBusinessDebug`      | `app/composeApp/build/outputs/apk/business/debug/`  |
| delivery | `./gradlew :app:composeApp:assembleDeliveryDebug`      | `app/composeApp/build/outputs/apk/delivery/debug/`  |

### Cual flavor necesita cada issue

Se determina por los labels del issue:
- `app:client` → flavor client
- `app:business` → flavor business  
- `app:delivery` → flavor delivery
- Multiples labels → generar multiples APKs
- Sin label `app:*` → **no requiere APK** (ver seccion "Issues sin impacto en UI")

### Issues sin impacto en UI (sin APK)

Algunos issues no tocan la UI y por lo tanto no requieren generacion de APK ni validacion
en el emulador. Ejemplos: cambios solo en backend, infra, hooks, docs, configuracion.

**Criterio de deteccion (en fase build):**
- El issue NO tiene ningun label `app:client`, `app:business` ni `app:delivery`
- Labels tipicos: `area:backend`, `tipo:infra`, `docs`

**Comportamiento del build:**
- El agente de build **omite la generacion del APK** para estos issues
- No se crea archivo en `qa/artifacts/`
- El build marca el issue con metadata `apk_required: false`

**Comportamiento de QA:**
- QA detecta que no hay APK para el issue y que `apk_required: false`
- **No levanta emulador** ni intenta instalar APK
- La validacion se realiza **solo sobre lo que corresponde**:
  - `area:backend` → QA-API (tests contra endpoints, verificacion de respuestas)
  - `tipo:infra` / `docs` → validacion estructural (lint, formato, que no rompa nada)
- Si el issue pasa la validacion correspondiente → `qa:passed` (o `qa:skipped` con justificacion si no aplica ninguna validacion automatizada)

**Flujo en la ventana QA:**
1. Se separan los issues en cola en dos grupos: **con APK** y **sin APK**
2. Issues sin APK se procesan primero (son rapidos, no necesitan emulador)
3. Si todos los issues pendientes son sin APK, **no se levanta el emulador**
4. Issues con APK se procesan despues, con el emulador levantado

### Implicancia para la ventana QA

La ventana QA **no genera APKs**, solo los consume. Al procesar un issue con APK:
1. Busca `qa/artifacts/{issue}-composeApp-{flavor}-debug.apk`
2. Si no existe → el issue se rechaza con motivo "APK faltante" y se re-encola para build
3. Nunca compilar dentro de la ventana QA (los recursos son para el emulador)

Al procesar un issue sin APK:
1. Verifica que el issue tenga metadata `apk_required: false`
2. Ejecuta la validacion correspondiente segun tipo (API, infra, docs)
3. No requiere emulador ni Maestro

## priority-windows.json

```json
{
  "qa": {
    "active": false,
    "activatedAt": null,
    "manual": false
  },
  "build": {
    "active": false,
    "activatedAt": null,
    "manual": false
  },
  "updatedAt": 1775727140428
}
```

Cuando la ventana se activa:
- `qa.active = true` → no lanzar nuevos dev
- `build.active = true` → no lanzar nuevos build
- `activatedAt` = timestamp de activacion (para timeout de seguridad)
- `manual = true` si fue activada manualmente via /api/pause

## Timeout de seguridad

Si la ventana QA lleva mas de **2 horas** activa sin completar ningun issue:
1. Loguear warning
2. Notificar por Telegram
3. NO cerrar automaticamente (puede haber issues lentos)

## Relacion con las 5 Capas

| Capa | Nombre                          | Estado                         |
|------|---------------------------------|--------------------------------|
| 1    | Ventanas de QA Exclusivas       | **Este documento** — aprobado  |
| 2    | Pre-Flight Checks en Pulpo      | **Aprobado** — `preflight-checks-spec.md` |
| 3    | Separar QA-API de QA-Android    | **Implementado** — `qa-api-spec.md` + `qa-api.sh` + ruteo en Pulpo |
| 4    | APK como Artefacto de Build     | **Aprobado** — cada issue genera su APK en fase build |
| 5    | Blindaje de Captura de Evidencia  | **Implementado** — `blindaje-evidencia-spec.md` (4 blindajes en qa-android.sh + pulpo.js) |

## Decisiones clave (registro)

- **2026-04-09:** Leo indica que emulador persistente 24/7 no es viable por recursos limitados.
  Propuesta revisada: ventanas QA exclusivas con emulador temporal.
- **2026-04-09:** Leo indica que build debe pausarse junto con dev durante ventana QA.
  Build + dev en paralelo con QA "hacen desastre".
- **2026-04-09:** Leo indica que build debe asegurar generacion del APK necesario para QA.
- **2026-04-09:** Leo indica que la generacion del APK es responsabilidad de la fase de build
  de cada issue, no de la ventana QA. Cada issue produce su propio APK porque el codigo
  difiere entre issues. La ventana QA solo consume APKs ya generados.
- **2026-04-09:** Leo indica que algunos issues no requieren APK (cambios sin impacto en UI).
  El build debe poder omitir la generacion del APK, y QA debe manejar la ausencia del APK
  sin error, validando solo lo que corresponde segun el tipo de issue.
- **2026-04-09:** Leo indica que el agente de QA NO debe levantar el emulador. Esa
  responsabilidad es exclusiva de la ventana de QA (Pulpo). El agente asume que el
  emulador ya esta corriendo cuando le toca ejecutar.
