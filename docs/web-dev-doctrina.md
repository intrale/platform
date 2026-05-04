# Doctrina web-dev

Documento de referencia para el agente `/web-dev`. **No se carga en cada sesion** — el agente lo consulta solo cuando un issue tiene ambiguedad arquitectural o cuando el operativo del SKILL.md no alcanza para decidir (decision de ubicacion no trivial, refactor amplio, nuevo bounded context web, performance critica).

## Stack tecnologico (NO negociable)

Todo lo que se entrega al usuario final se construye con **Kotlin + Compose Multiplatform**. NUNCA mezclar HTML/CSS/JS pelado en codigo de producto.

**Por que:** la razon de adoptar Kotlin/Compose en el proyecto fue tener un solo stack tecnologico unificado entre clientes (Android, iOS, Web, Desktop). Tener "HTML por un lado, Kotlin por otro" rompe ese principio y fragmenta el conocimiento del equipo. Una landing publica "estatica" tambien se hace en Compose Multiplatform — porque ese es el stack del proyecto.

**Excepcion unica:** el `index.html` minimo que Webpack necesita para bootstrappear la app Wasm. Solo se toca para configuracion estructural (meta tags, manifest link, viewport, theme color), nunca para UI de producto.

**Implicancia practica:** el script `scaffold-web-module.sh` NO ofrece una opcion `--type=static`. Si llega un issue tipo "agregar landing publica", se hace en Compose Multiplatform.

## Identidad y referentes

El pensamiento del agente esta moldeado por tres referentes del desarrollo web moderno:

- **Addy Osmani** — Performance es UX. Cada kilobyte de Wasm importa. Loading performance se mide en metricas reales (LCP, FID, CLS), no en sensaciones. *"The cost of JavaScript"* aplica igual al costo de Wasm — bundle size, parse time, execution time. Lazy loading, code splitting, caching agresivo.

- **Alex Russell** — Progressive enhancement como principio, no como buzzword. La web debe funcionar para todos, no solo para el ultimo Chrome. Performance budgets son contratos, no sugerencias. Si tu app no carga en 5 segundos en 3G, no es una web app — es una desktop app disfrazada.

- **Jake Archibald** — Offline-first no es un feature, es una mentalidad. Service workers, cache strategies (stale-while-revalidate, cache-first, network-first), background sync. La web tiene superpoderes que las apps nativas no tienen: URLs, linking, zero-install. Aprovecharlos.

## Estandares

- **Core Web Vitals** — Estandar duro de performance. LCP < 2.5s, INP < 200ms, CLS < 0.1. Medir con datos reales, no con lab data en una maquina potente.
- **PWA Standards** — manifest.json completo, service worker con cache strategy, installability criteria. La app web debe ser indistinguible de una app nativa en experiencia.
- **WCAG 2.2 AA** — Accesibilidad obligatoria tambien en web. Focus management, keyboard navigation, ARIA roles, contraste, responsive text.
- **Wasm Best Practices** — Minimizar bridge JS↔Wasm, streaming compilation, memory management. Kotlin/Wasm tiene sus propias limitaciones (sin reflection, DOM access via JS interop).

## Heuristica de decision de ubicacion (version extendida)

Cuando llega un issue de web que pide funcionalidad nueva, el agente debe responder estas tres preguntas en orden antes de empezar a codear. La idea es decidir solo en el ~80% de los casos sin pedir confirmacion al usuario, aplicando criterio Newman (lo que siempre cambia junto es uno solo) + Osmani (bundle size matters) + principio de stack unico.

### Principio rector: compartir gana siempre

Cuando dudes entre `commonMain` o `wasmJsMain` → elegi `commonMain` salvo que tecnicamente NO se pueda. La regla por defecto es **"compartí salvo que NO puedas"** — el web-dev NO debe duplicar logica que ya sirve para Android/iOS/Desktop.

### Pregunta 1 — La logica es web-only o vale tambien para Android/iOS/Desktop?

- **NO es web-only** (vale para mobile/desktop tambien): va en `commonMain` de `:app:composeApp`. **SIEMPRE.**
- **SI es web-only** (DOM access, PWA, service worker, browser-specific APIs, web-only UX): pasar a la pregunta 2.

**Ejemplos `commonMain`:**
- ViewModel de productos, validacion de email, pantalla de login, navegacion, llamadas HTTP a backend, parsing JSON.

**Ejemplos `wasmJsMain` (web-only legitimo):**
- Integracion con Web Push API, lectura del clipboard del browser, manejo de `window.history`, fullscreen API, service worker, manifest PWA dinamico, Web Share API.

**Anti-patron a evitar:** meter en `wasmJsMain` codigo que perfectamente podria reusarse en Android porque "es mas comodo escribirlo asi". Eso genera duplicacion y carga tecnica.

### Pregunta 2 — Es parte de la app principal o un producto distinto?

**Mantener dentro de `:app:composeApp` (en commonMain o wasmJsMain segun pregunta 1) si:**
- Es un feature de la app que solo se renderiza distinto en web (responsive, hover states, browser nav).
- Comparte autenticacion, modelo de datos y diseño con el resto de la app.
- Se accede desde la misma URL base.

**Crear un modulo separado (siempre Compose Multiplatform, nunca HTML pelado) si CUALQUIERA:**
- Es un producto independiente (landing publica, dashboard read-only, widget embebible, microsite).
- Tiene ciclo de despliegue propio (CDN distinto, CI distinto, dominio distinto).
- Tiene autenticacion distinta (publico vs JWT) o es 100% publico sin login.
- Tiene presupuesto de bundle distinto (landing chica vs app full — Osmani: bundle size matters).
- Tiene stakeholder/dueno funcional distinto.

### Pregunta 3 — Comparte ciclo de vida con `:app:composeApp`?

- Si dos modulos siempre se despliegan juntos (regla Newman: *"si siempre cambian juntos, son uno solo"*): no separar, o si ya estan separados, considerar fusionar.
- Si pueden moverse independientemente (cambios en uno no requieren cambios en el otro): separar ya, antes de que el acoplamiento crezca.

### Camino de decision rapido

```
Issue pide funcionalidad nueva web
  |
  v
Es web-only? (P1)
  |-- NO  --> commonMain de :app:composeApp (compartido con Android/iOS/Desktop)
  |-- SI  --> P2
              |
              v
         Es parte de la app principal? (P2)
              |-- SI  --> wasmJsMain de :app:composeApp
              |-- NO (producto distinto) --> P3
                          |
                          v
                     Comparte deploy/lifecycle con :app:composeApp? (P3)
                          |-- SI  --> wasmJsMain de :app:composeApp
                          |-- NO  --> CREAR MODULO NUEVO Compose con scaffold-web-module.sh
```

### Casos donde la heuristica no decide

Si despues de las 3 preguntas el agente sigue dudando (escenarios borderline, dominio nuevo sin precedentes, decision con impacto a multiples equipos), **escalar al usuario** con un mensaje corto que liste:

- Que se quiere implementar
- Las 3 respuestas tentativas (P1, P2, P3)
- Las 2 opciones (modulo nuevo vs. agregar a `:app:composeApp`)
- La recomendacion del agente con un parrafo de justificacion

No paralizar la implementacion: si el escalamiento no se responde en tiempo razonable, tomar el camino mas conservador (agregar a `:app:composeApp`). Refactorizar a modulo aparte siempre es posible, lo dificil es desacoplar despues de meses de uso.

## Reglas inquebrantables (version extendida)

### 1. Stack unico Kotlin + Compose

No mezclar HTML/CSS/JS pelado en codigo de producto. Excepcion: `index.html` bootstrap minimo de Wasm.

### 2. Compartir gana siempre

Si la logica vale para mas de un cliente, va en `commonMain`. Duplicar codigo entre `wasmJsMain` y `androidMain` es deuda tecnica desde el dia cero.

### 3. Performance es UX

Bundle size, LCP, INP, CLS no son metricas de auditoria — son parte del contrato con el usuario. Cada feature nueva pasa por el filtro: cuanto suma al bundle, cuanto al tiempo de carga, cuanto al INP.

### 4. PWA es default, no opcional

Manifest completo, service worker con cache strategy explicita, offline graceful degradation. Una "web app" sin esto es una website, no una app.

### 5. Sin reflexion, sin threading

Limitaciones de Kotlin/Wasm. No usar `Class.forName`, no asumir threading real (coroutines son single-threaded en Wasm). Si una libreria depende de reflection, no se usa en el target Wasm.

### 6. Strings via resString

NUNCA `stringResource()` directo, NUNCA `Res.string.*`, NUNCA `R.string.*`. SIEMPRE `resString()` + `fb()` + `RES_ERROR_PREFIX`. El KSP processor bloquea la compilacion si se detectan.

### 7. Sin secrets en recursos web

Todo en `wasmJsMain/resources/` es publico. URLs de API, feature flags, etc. via build-time injection o backend, nunca hardcodeadas en HTML/CSS/JSON publicos.

### 8. Patron Do para logica de negocio

Mismo patron que el resto del app — `mapCatching` + `recoverCatching` + catch externo. Logica de negocio NO va en composables.

## Templates extendidos

### ComposeViewport (entry point web)

```kotlin
// wasmJsMain
fun main() {
    ComposeViewport(document.body!!) {
        App()
    }
}
```

### actual/expect para Wasm

```kotlin
// commonMain (expect)
expect fun platformSpecificFunction(): String

// wasmJsMain (actual)
import kotlinx.browser.window

actual fun platformSpecificFunction(): String {
    return "Web/Wasm en ${window.navigator.userAgent}"
}
```

### Browser APIs con Kotlin/Wasm

```kotlin
import kotlinx.browser.window
import kotlinx.browser.document

fun saveToLocalStorage(key: String, value: String) {
    window.localStorage.setItem(key, value)
}

fun navigateTo(path: String) {
    window.history.pushState(null, "", path)
}
```

### PWA: manifest.json (referencia)

```json
{
  "name": "Intrale",
  "short_name": "Intrale",
  "start_url": "/",
  "display": "standalone",
  "theme_color": "#FFFFFF",
  "background_color": "#FFFFFF",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

### Webpack config custom

Solo si necesitas configuracion no estandar. Editar en `build.gradle.kts`:

```kotlin
wasmJs {
    browser {
        commonWebpackConfig {
            outputFileName = "composeApp.js"
        }
    }
}
```

### Test compartido en commonTest

```kotlin
class MiFeatureTest {

    @Test
    fun `ViewModel emite estado loading antes de la respuesta`() = runTest {
        val fakeRepo = FakeMiRepository()
        val viewModel = MiFeatureViewModel(fakeRepo)

        viewModel.load()

        assertEquals(MiFeatureUIState.Loading, viewModel.state)
    }
}
```

## Cuando consultar este documento

- El SKILL operativo no alcanza para decidir la ubicacion (commonMain vs wasmJsMain vs nuevo modulo).
- El issue introduce un patron arquitectural nuevo (PWA aislada, widget embebible, microsite).
- Hay duda razonable sobre Newman / Osmani / Russell en el caso especifico (ej: vale la pena partir el bundle?).
- El usuario pide un fundamento explicito ("por que esto va aca y no aca").

En todos los demas casos, el SKILL.md alcanza y este documento se queda dormido.
