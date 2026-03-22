# Guía de Build Flavors Android — Intrale Platform

> Documentación técnica de los product flavors de Android (client, business, delivery) y cómo compilar cada variante de la aplicación.

---

## 1. ¿Qué son los Product Flavors?

Los **Product Flavors** en Gradle permiten compilar múltiples variantes de la misma aplicación con diferentes configuraciones, como package names, nombres visibles en la pantalla home y características específicas por negocio.

En **Intrale Platform**, definimos la dimensión `appType` con **3 flavors**:

| Flavor | Package ID | Nombre en App | Propósito |
|--------|-----------|---------------|-----------|
| **client** | `com.intrale.app.client[.slug]` | Variable (default: "Intrale") | App cliente personalizable por negocio |
| **business** | `com.intrale.app.business` | "Intrale Negocios" | App específica para comercios/negocios |
| **delivery** | `com.intrale.app.delivery` | "Intrale Repartos" | App específica para repartidores/delivery |

### Dimensión appType

Todos los flavors pertenecen a la dimensión **`appType`**. Gradle permite compilar solo un flavor por dimensión en el mismo APK.

---

## 2. Configuración de Flavors en build.gradle.kts

Los flavors están definidos en `/app/composeApp/build.gradle.kts`:

```kotlin
android {
    namespace = "ar.com.intrale"
    flavorDimensions += "appType"

    productFlavors {
        create("client") {
            dimension = "appType"
            applicationId = clientApplicationId  // com.intrale.app.client[.slug]
            manifestPlaceholders += mapOf("appName" to flavorAppName)
            resValue("string", "app_name", flavorAppName)
        }

        create("business") {
            dimension = "appType"
            applicationId = businessApplicationId  // com.intrale.app.business
            manifestPlaceholders += mapOf("appName" to "Intrale Negocios")
            resValue("string", "app_name", "Intrale Negocios")
        }

        create("delivery") {
            dimension = "appType"
            applicationId = deliveryApplicationId  // com.intrale.app.delivery
            manifestPlaceholders += mapOf("appName" to "Intrale Repartos")
            resValue("string", "app_name", "Intrale Repartos")
        }
    }
}
```

### Variables de configuración

El build detecta automáticamente el flavor según el tipo de tarea:

```kotlin
val inferredAppType = providers.provider {
    val taskNames = gradle.startParameter.taskNames.map(String::lowercase)

    when {
        taskNames.any { it.contains("delivery") } -> "DELIVERY"
        taskNames.any { it.contains("business") } -> "BUSINESS"
        else -> "CLIENT"
    }
}
```

- Si ejecutas `gradlew assembleDelivery*`, se asume `appType = DELIVERY`
- Si ejecutas `gradlew assembleBusiness*`, se asume `appType = BUSINESS`
- En otros casos, se asume `appType = CLIENT`

También se pueden sobrescribir explícitamente:
```bash
export APP_TYPE=BUSINESS  # o -PappType=business
```

---

## 3. Identificadores de aplicación (ApplicationId)

Cada flavor tiene un `applicationId` único para poder instalar varias variantes en el mismo dispositivo:

### client (personalizable)

```kotlin
val clientApplicationSuffix = clientSlug.map(::sanitizePackageSuffix).getOrElse("")
val clientApplicationId = if (clientApplicationSuffix.isBlank()) {
    "com.intrale.app.client"
} else {
    "com.intrale.app.client.$clientApplicationSuffix"
}
```

- **Default**: `com.intrale.app.client`
- **Con clientSlug**: `com.intrale.app.client.{slug-sanitizado}`

Ejemplo: Si compilas con `-PclientSlug="Negocio-ABC"`, el package será `com.intrale.app.client.negocio.abc`.

### business

```kotlin
val businessApplicationId = "com.intrale.app.business"
```

Package fijo: `com.intrale.app.business`

### delivery

```kotlin
val deliveryApplicationId = "com.intrale.app.delivery"
```

Package fijo: `com.intrale.app.delivery`

---

## 4. Compilación por flavor

### Build Debug (instalación en emulador/device)

**Client (default)**
```bash
./gradlew clean build

# O explícitamente
./gradlew :app:composeApp:installDebug
```

**Business**
```bash
./gradlew :app:composeApp:installBusinessDebug
```

**Delivery**
```bash
./gradlew :app:composeApp:installDeliveryDebug
```

### Build Release (APK para distribución)

**Client**
```bash
./gradlew :app:composeApp:assembleClientRelease
# APK en: app/composeApp/build/outputs/apk/client/release/
```

**Business**
```bash
./gradlew :app:composeApp:assembleBusinessRelease
# APK en: app/composeApp/build/outputs/apk/business/release/
```

**Delivery**
```bash
./gradlew :app:composeApp:assembleDeliveryRelease
# APK en: app/composeApp/build/outputs/apk/delivery/release/
```

### Build con propiedades personalizadas

**Client con nombre y slug personalizado**
```bash
./gradlew :app:composeApp:assembleClientDebug \
  -PclientSlug="Negocio-ABC" \
  -PclientAppName="Mi Tienda"
```

Este comando:
- Crea package: `com.intrale.app.client.negocio.abc`
- Nombre en launcher: "Mi Tienda"

**Business con entorno local**
```bash
./gradlew :app:composeApp:assembleBusinessDebug \
  -PLOCAL_BASE_URL="http://192.168.1.10:8080/"
```

---

## 5. Variante compilada (APK output)

Después de compilar, los APKs generados se encuentran en:

```
app/composeApp/build/outputs/apk/
├── client/
│   ├── debug/
│   │   └── app-client-debug.apk
│   └── release/
│       └── app-client-release.apk
├── business/
│   ├── debug/
│   │   └── app-business-debug.apk
│   └── release/
│       └── app-business-release.apk
└── delivery/
    ├── debug/
    │   └── app-delivery-debug.apk
    └── release/
        └── app-delivery-release.apk
```

---

## 6. Diferencias funcionales por flavor

### Cliente (client)

- **Package**: `com.intrale.app.client[.slug]` (personalizable)
- **Nombre**: Variable según `clientAppName` (default: "Intrale")
- **Funcionalidad**: App genérica cliente, sin features específicas de business/delivery
- **Uso**: Para clientes finales, aplicaciones blancas, distribución seleccionada

### Negocio (business)

- **Package**: `com.intrale.app.business`
- **Nombre**: "Intrale Negocios"
- **Funcionalidad**: Features específicas para gestión de comercios
- **Uso**: Para distribución Play Store, app público de Intrale Negocios

### Repartos (delivery)

- **Package**: `com.intrale.app.delivery`
- **Nombre**: "Intrale Repartos"
- **Funcionalidad**: Features específicas para gestión de entregas/repartidores
- **Uso**: Para distribución Play Store, app público de Intrale Repartos

---

## 7. Verificar qué flavor se compilará

Para ver qué flavor detecta Gradle, usa:

```bash
./gradlew tasks | grep -i "assemble"
```

Esto lista todas las tareas de assembly disponibles. El patrón es:
- `assemble[Flavor][BuildType]`
- `install[Flavor][BuildType]`

Ejemplo:
```
assembleClientDebug    - Assembles the Debug version of app (client)
assembleClientRelease  - Assembles the Release version of app (client)
assembleBusinessDebug  - Assembles the Debug version of app (business)
...
```

---

## 8. Cambios de código condicionales por flavor

Si necesitas código diferente según el flavor, usa **Kotlin expect/actual** o **Gradle sourceSet directories**:

### Usando sourceSet

Crea estructura:
```
app/composeApp/src/
├── commonMain/kotlin/      # Código compartido
├── clientMain/kotlin/      # Específico de client
├── businessMain/kotlin/    # Específico de business
└── deliveryMain/kotlin/    # Específico de delivery
```

En `build.gradle.kts`:
```kotlin
android {
    sourceSets {
        getByName("client") { manifest.srcFile("src/clientMain/AndroidManifest.xml") }
        getByName("business") { manifest.srcFile("src/businessMain/AndroidManifest.xml") }
        getByName("delivery") { manifest.srcFile("src/deliveryMain/AndroidManifest.xml") }
    }
}
```

### Detectar flavor en runtime

Usa la variable compilada en `BuildKonfig`:
```kotlin
val appType: String = BuildKonfig.APP_TYPE  // "CLIENT", "BUSINESS", o "DELIVERY"
```

---

## 9. CI/CD y builds en servidor

### GitHub Actions

En el CI, las builds se lanzan explícitamente con:

```bash
# Build all variants
./gradlew clean build

# Build específico para Play Store
./gradlew :app:composeApp:bundleBusinessRelease
./gradlew :app:composeApp:bundleDeliveryRelease
```

### Variables de entorno

El CI inyecta:
- `APP_TYPE` — marca el flavor a compilar
- `LOCAL_BASE_URL` — endpoint del backend
- `STORE_AVAILABLE` — boolean para activar Google Play linking

---

## 10. Debugging y troubleshooting

### "Multiple variants, need to specify which to build"
```bash
# Error: ambiguo qué flavor compilar
# Solución:
./gradlew :app:composeApp:installBusinessDebug  # ser explícito
```

### Package ya instalado (diferente flavor)
```bash
# Error: "Application already exists with different signature"
# Solución: desinstalar la otra variante primero
adb uninstall com.intrale.app.client
adb uninstall com.intrale.app.business
adb uninstall com.intrale.app.delivery

# Luego instalar la deseada
./gradlew :app:composeApp:installBusinessDebug
```

### Verificar qué app está instalada en device
```bash
adb shell pm list packages | grep intrale
# Output esperado:
# package:com.intrale.app.business
```

---

## 11. Cheat Sheet de comandos

| Tarea | Comando |
|-------|---------|
| **Build completo local** | `./gradlew clean build` |
| **Install client en device** | `./gradlew :app:composeApp:installClientDebug` |
| **Install business en device** | `./gradlew :app:composeApp:installBusinessDebug` |
| **Install delivery en device** | `./gradlew :app:composeApp:installDeliveryDebug` |
| **APK client release** | `./gradlew :app:composeApp:assembleClientRelease` |
| **APK business release** | `./gradlew :app:composeApp:assembleBusinessRelease` |
| **APK delivery release** | `./gradlew :app:composeApp:assembleDeliveryRelease` |
| **Bundle business (Play)** | `./gradlew :app:composeApp:bundleBusinessRelease` |
| **Bundle delivery (Play)** | `./gradlew :app:composeApp:bundleDeliveryRelease` |
| **Listar builds disponibles** | `./gradlew tasks \| grep assemble` |
| **Desinstalar client** | `adb uninstall com.intrale.app.client` |
| **Desinstalar business** | `adb uninstall com.intrale.app.business` |
| **Desinstalar delivery** | `adb uninstall com.intrale.app.delivery` |

---

## 12. Enlaces relacionados

- [`app/composeApp/build.gradle.kts`](../app/composeApp/build.gradle.kts) — Configuración de flavors
- [`docs/arquitectura-app.md`](arquitectura-app.md) — Arquitectura del módulo app
- [`docs/arquitectura-backend.md`](arquitectura-backend.md) — Configuración de backend
- [CLAUDE.md](../CLAUDE.md) — Comandos de build esenciales (línea 1-20)

---

## Preguntas frecuentes

### ¿Puedo instalar dos flavors al mismo tiempo en el mismo device?

**Sí.** Como tienen diferentes `applicationId`, Android los considera apps distintas.

```bash
./gradlew :app:composeApp:installBusinessDebug
./gradlew :app:composeApp:installDeliveryDebug
adb shell pm list packages | grep intrale
# package:com.intrale.app.business
# package:com.intrale.app.delivery
```

### ¿Cómo cambio el nombre visible de la app client?

Usa la propiedad `-PclientAppName`:

```bash
./gradlew :app:composeApp:installClientDebug -PclientAppName="Mi Negocio"
```

Luego el launcher mostrará "Mi Negocio" en lugar de "Intrale".

### ¿Dónde están los APKs después de compilar?

Están en:
```
app/composeApp/build/outputs/apk/{flavor}/{buildType}/
```

Por ejemplo:
- Business release: `app/composeApp/build/outputs/apk/business/release/app-business-release.apk`

### ¿Puedo compilar múltiples flavors en un solo comando?

En un solo APK: **no**, porque solo un flavor por dimensión.

Pero sí puedes generar múltiples APKs:
```bash
./gradlew :app:composeApp:assembleDebug      # client + business + delivery debug
./gradlew :app:composeApp:assembleRelease    # client + business + delivery release
```

Esto genera 6 APKs (3 flavors × 2 buildTypes).

---

**Documento actualizado**: 2026-03-22
**Versión de Gradle**: 8.x
**Versión de Kotlin**: 2.2.21
**Versión de Compose Multiplatform**: 1.8.2
