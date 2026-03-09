# Estrategia de Distribución Friends & Family — Intrale Platform

**Versión:** 1.0
**Fecha:** 2026-03-09
**Issue:** [#1269](https://github.com/intrale/platform/issues/1269)
**Audiencia:** Product Owner · Engineering · DevOps/CI-CD

---

## Resumen ejecutivo

Intrale Platform es un ecosistema multiplataforma de 3 flavors (client, business, delivery) × 4 targets (Android, iOS, Desktop/JVM, Web/Wasm). Para la fase Friends & Family se necesita un canal de distribución controlado que permita que beta testers prueben el flujo completo sin publicar en stores públicos.

**Estrategia recomendada (resumen):**

| Plataforma | Canal recomendado | Costo | Esfuerzo setup |
|------------|-------------------|-------|----------------|
| Android | Firebase App Distribution | Gratuito | M |
| iOS | TestFlight (App Store Connect) | $99/año | L |
| Desktop/JVM | GitHub Releases privado + script | Gratuito | S |
| Web/Wasm | AWS S3 + CloudFront con URL protegida | ~$5/mes | S |

---

## 1. Contexto técnico del proyecto

### 1.1 Product Flavors Android

El proyecto define 3 flavors en `app/composeApp/build.gradle.kts`:

| Flavor | Application ID | App Name |
|--------|---------------|----------|
| `client` | `com.intrale.app.client[.<slug>]` | Intrale |
| `business` | `com.intrale.app.business` | Intrale Negocios |
| `delivery` | `com.intrale.app.delivery` | Intrale Repartos |

El flavor `client` soporta múltiples instancias por negocio via `-PclientSlug=<negocio>`.

**Versión actual:** `versionCode=1`, `versionName="1.0"` (centralizado en `build.gradle.kts`).

### 1.2 Estado actual del CI/CD

- **`main.yml`** — Push a `main` → build backend → deploy `users-all.jar` a AWS Lambda `kotlinTest`
- **`pr-checks.yml`** — PRs → tests + cobertura + E2E (Playwright) + gate de calidad
- **Firebase**: NO instalado (plataforma usa AWS: Cognito + DynamoDB + Lambda)
- **Sin infraestructura de distribución**: no hay Play Store, TestFlight, ni App Distribution configurados

### 1.3 Targets disponibles

- **Android**: 3 APKs/AABs independientes
- **iOS**: Framework KMP → `iosApp/` (requiere Mac para compilar; no ejecutable en Windows)
- **Desktop/JVM**: Distribucables Dmg (macOS) / Msi (Windows) / Deb (Linux) via Compose Desktop
- **Web/Wasm**: PWA lista (`manifest.json`, iconos, `composeApp.js`)

---

## 2. Análisis comparativo por plataforma

### 2.1 Android

#### Opción A — Firebase App Distribution

| | |
|---|---|
| **Descripción** | Servicio Firebase para distribución de APKs directamente a testers |
| **Cómo funciona** | Subida de APK vía CLI o GitHub Action → testers reciben email/link → instalan directamente |
| **Gestión de testers** | Grupos de testers con emails; invitación por link o email |
| **Historial de builds** | Sí, con notas de release y comparación entre versiones |
| **Actualizaciones** | App avisa al tester que hay nueva versión disponible |
| **Métricas** | Descargas, dispositivos, versiones activas |
| **Integración CI/CD** | Firebase CLI + GitHub Action oficial `wzieba/Firebase-Distribution-Github-Action` |
| **Costo** | Gratuito para hasta 1.000 testers/mes; requiere cuenta Firebase (no tiene costo base) |
| **Desventajas** | Requiere crear proyecto Firebase (compatible con AWS: no reemplaza backend); notificaciones por email pueden ir a spam |
| **Compatibilidad con flavors** | Cada flavor sería una app separada en Firebase (3 proyectos o 1 proyecto con 3 apps) |

**Comandos clave:**
```bash
# Generar APKs para los 3 flavors
./gradlew :app:composeApp:assembleClientDebug
./gradlew :app:composeApp:assembleBusinessDebug
./gradlew :app:composeApp:assembleDeliveryDebug

# Subir vía Firebase CLI
firebase appdistribution:distribute app/composeApp/build/outputs/apk/client/debug/composeApp-client-debug.apk \
  --app $FIREBASE_APP_ID_CLIENT \
  --groups "friends-family" \
  --release-notes "Build $VERSION_NAME ($VERSION_CODE)"
```

#### Opción B — Google Play Internal Testing

| | |
|---|---|
| **Descripción** | Canal privado dentro de Google Play Console |
| **Cómo funciona** | AAB subido a Play Console → testers reciben link de Play Store → instalan como app normal |
| **Gestión de testers** | Hasta 100 testers con cuenta Google; también permite "Internal App Sharing" (link directo, sin límite) |
| **Actualizaciones** | Automáticas via Play Store |
| **Requisito previo** | Cuenta de desarrollador Google Play ($25 USD, pago único) |
| **Costo** | $25 USD una vez (+ fee Play Store existente si ya hay cuenta) |
| **Ventajas** | Experiencia idéntica al usuario final; actualizaciones OTA; firma gestionada por Play |
| **Desventajas** | Requiere cuenta Play para cada tester (email Google); setup más complejo; revisión de políticas aunque sea Internal |
| **Internal App Sharing** | Alternativa dentro de Play: link directo sin Google account obligatorio, sin revisión |

#### Opción C — APK Directo (Telegram/Drive)

| | |
|---|---|
| **Descripción** | Generación de APK debug y distribución manual |
| **Ventajas** | Sin setup, inmediato |
| **Desventajas** | Actualización 100% manual; sin historial; no escala; "instalar desde fuentes desconocidas" requerido |
| **Costo** | Gratuito |

#### Recomendación Android: **Firebase App Distribution**

**Justificación:**
- Sin costo de entrada (a diferencia de Play Store $25)
- Distribución directa sin app store (testers no necesitan cuenta Google configurada)
- Integración nativa con GitHub Actions
- Soporte nativo para múltiples apps (un proyecto Firebase, 3 apps Android)
- Compatible con la arquitectura AWS actual (Firebase solo se usa para distribución, no reemplaza backend)
- El "Internal App Sharing" de Play puede ser complementario para cuando se registre en Play Store

---

### 2.2 iOS

#### Opción A — TestFlight (App Store Connect)

| | |
|---|---|
| **Descripción** | Plataforma oficial Apple para beta testing |
| **Requisito previo** | Apple Developer Program ($99 USD/año) |
| **Testers internos** | Hasta 100 (reciben invitación por email, sin revisión de Apple) |
| **Testers externos** | Hasta 10.000 (requiere revisión beta de Apple, ~24-48h) |
| **Actualizaciones** | Automáticas via TestFlight app |
| **Expiración** | Build expira a los 90 días sin actividad |
| **Limitaciones** | Requiere build desde Mac con Xcode; certificados de distribución; provisioning profiles |
| **Feedback** | Testers pueden enviar screenshots y feedback desde TestFlight |
| **Integración CI/CD** | `fastlane` + `pilot` (upload a TestFlight) |
| **Costo** | $99/año Developer Program (incluye todo: TestFlight, certificados, provisioning) |

**Flujo resumido:**
```
Código KMP → Compilar en Mac (Xcode) → Archive → Upload a App Store Connect → TestFlight → Invitar testers
```

#### Opción B — Ad Hoc Distribution

| | |
|---|---|
| **Descripción** | IPA firmado con certificado Ad Hoc + lista de UDIDs |
| **Límite** | 100 dispositivos/año (cuota del Developer Program) |
| **Proceso** | Recolectar UDID de cada dispositivo → agregar a provisioning profile → generar IPA → distribuir por email/link |
| **Desventajas** | Alta complejidad operativa; gestión manual de UDIDs; no escala; proceso de registro de dispositivos engorroso |
| **Costo** | $99/año Developer Program |

#### Opción C — Enterprise Distribution

| | |
|---|---|
| **Descripción** | Distribución privada sin App Store para organizaciones |
| **Sin límite** | Dispositivos ilimitados dentro de la organización |
| **Costo** | $299/año Enterprise Program |
| **Desventaja** | Restricción Apple: solo para empleados de la organización, no para usuarios externos; riesgo de revocación si se usa incorrectamente |

#### Recomendación iOS: **TestFlight**

**Justificación:**
- Canal oficial Apple; sin alternativa real para distribución legítima fuera del Ad Hoc
- El Developer Program ($99/año) es inversión necesaria para cualquier distribución iOS
- TestFlight es gratuito dentro del Developer Program
- 100 testers internos son suficientes para F&F
- La revisión beta para externos (~24-48h) es manejable
- Ad Hoc descartado: gestión de UDIDs no escala y es operativamente costoso

**Bloqueador a resolver:** La compilación iOS requiere Mac con Xcode. Opciones:
1. Mac en equipo → build local + upload manual
2. GitHub Actions con runner `macos-latest` (pago, ~$0.08/min en GitHub)
3. Servicio CI especializado (Bitrise, Codemagic — tienen tier gratuito con Mac)

---

### 2.3 Desktop/JVM

#### Opción A — GitHub Releases (privado)

| | |
|---|---|
| **Descripción** | Subir instaladores como assets de GitHub Release en repositorio privado |
| **Formatos** | Dmg (macOS), Msi (Windows), Deb (Linux) — generados por Compose Desktop |
| **Acceso** | URL directa de descarga; repositorio privado limita acceso a testers con GitHub account |
| **Actualización** | Manual (el usuario descarga la nueva versión) |
| **Integración CI/CD** | `gh release create` + `gh release upload` |
| **Costo** | Gratuito |
| **Desventaja** | Testers necesitan cuenta GitHub o URL pública con token |

**Comandos de build:**
```bash
./gradlew :app:composeApp:packageDistributionForCurrentOS  # según SO del runner
./gradlew :app:composeApp:packageMsi     # Windows
./gradlew :app:composeApp:packageDmg     # macOS
./gradlew :app:composeApp:packageDeb     # Linux
```

#### Opción B — Servidor HTTP privado con versioning

| | |
|---|---|
| **Descripción** | Endpoint HTTP con JSON de versiones + descarga de instaladores |
| **Auto-update** | La app puede consultar la API para detectar nuevas versiones |
| **Hosting** | AWS S3 (estático) o servidor propio |
| **Costo** | ~$1-5/mes en S3 + CloudFront |
| **Complejidad** | Requiere implementar lógica de auto-update en la app (Desktop) |

#### Opción C — Telegram/Drive (distribución manual)

| | |
|---|---|
| **Descripción** | Compartir JAR o instalador por Telegram / Google Drive / email |
| **Ventajas** | Sin setup |
| **Desventajas** | Sin actualización automática; sin historial; sin métricas |
| **Costo** | Gratuito |

#### Recomendación Desktop: **GitHub Releases (privado) + script de notificación Telegram**

**Justificación:**
- Sin costo adicional; integración natural con el repo
- CI/CD ya usa `gh` CLI — extensión trivial
- Los testers F&F son técnicos y tienen acceso a GitHub (o se les da URL directa)
- Para auto-update: Compose Desktop tiene soporte experimental via `AppUpdater`; puede implementarse en sprint posterior
- Se complementa con notificación automática por Telegram (ya integrado en el proyecto)

---

### 2.4 Web/Wasm

#### Opción A — AWS S3 + CloudFront con URL protegida

| | |
|---|---|
| **Descripción** | Deploy del build Wasm a S3 + CloudFront con signed URLs o Basic Auth via Lambda@Edge |
| **Acceso** | URL privada compartida con testers (signed URL con expiración o credenciales) |
| **Actualizaciones** | Automáticas (los usuarios reciben la versión nueva al refrescar) |
| **Stack** | AWS ya usado en el proyecto (consistencia de infraestructura) |
| **Costo** | ~$1-5/mes (S3 + CloudFront) |
| **Integración CI/CD** | `aws s3 sync` + `aws cloudfront create-invalidation` |

#### Opción B — Vercel Preview Deployments

| | |
|---|---|
| **Descripción** | Deploy automático por rama en Vercel |
| **Acceso** | URL única por branch (`https://intrale-git-feature-x.vercel.app`) |
| **Actualizaciones** | Automáticas por push |
| **Costo** | Gratuito (tier hobby) |
| **Desventaja** | Nuevo proveedor; dependencia de Vercel; configuración de build Wasm puede ser compleja |

#### Opción C — Staging URL con Basic Auth

| | |
|---|---|
| **Descripción** | Servidor con nginx/Apache + Basic Auth |
| **Ventajas** | Simple |
| **Desventajas** | Requiere servidor dedicado; Basic Auth es insegura sin HTTPS |

#### Recomendación Web: **AWS S3 + CloudFront con URL privada**

**Justificación:**
- Consistencia con el stack AWS ya existente (no agrega proveedores nuevos)
- Costo mínimo (<$5/mes para tráfico F&F)
- CloudFront signed URLs permiten acceso controlado sin autenticación compleja
- Actualizaciones automáticas e inmediatas al hacer deploy
- Fácil de configurar en GitHub Actions (`aws s3 sync`)

---

## 3. Matriz comparativa

### Android

| Criterio | Firebase App Distribution | Play Internal Testing | APK Directo |
|----------|--------------------------|----------------------|-------------|
| Costo | **Gratuito** | $25 USD | Gratuito |
| Setup | Medio | Alto | **Bajo** |
| Auto-update | ✅ (notificación) | ✅ (Play OTA) | ❌ |
| Historial de builds | ✅ | ✅ | ❌ |
| Integración CI/CD | **✅ Nativa** | ✅ | Manual |
| Métricas | ✅ | ✅ | ❌ |
| Soporte 3 flavors | ✅ (3 apps) | ✅ (3 apps) | Manual |
| Cuenta Google requerida | No | Sí | No |
| **Recomendado** | **✅** | — | — |

### iOS

| Criterio | TestFlight | Ad Hoc | Enterprise |
|----------|------------|--------|------------|
| Costo | $99/año | $99/año | $299/año |
| Testers máx. | 10.100 | 100 dispositivos | Ilimitado |
| Setup | Medio | **Alto** | Alto |
| Auto-update | ✅ | ❌ | ❌ |
| Gestión UDIDs | No | **Sí (manual)** | No |
| Apple review | Solo externos | No | No |
| **Recomendado** | **✅** | — | — |

### Desktop/JVM

| Criterio | GitHub Releases | Servidor HTTP | Telegram/Drive |
|----------|----------------|---------------|----------------|
| Costo | **Gratuito** | ~$5/mes | Gratuito |
| Auto-update | ❌ (v1) | ✅ (con impl.) | ❌ |
| Historial | ✅ | ✅ | ❌ |
| Integración CI/CD | **✅** | ✅ | Manual |
| Acceso controlado | ✅ (repo privado) | ✅ | ❌ |
| **Recomendado** | **✅** | Fase 2 | — |

### Web/Wasm

| Criterio | AWS S3 + CloudFront | Vercel | Staging Basic Auth |
|----------|--------------------|---------|--------------------|
| Costo | ~$5/mes | **Gratuito** | Variable |
| Stack consistency | **✅ AWS** | ❌ nuevo | ❌ |
| Auto-update | ✅ | ✅ | ✅ |
| Integración CI/CD | **✅** | ✅ | Manual |
| Acceso controlado | ✅ signed URLs | ✅ por branch | Básico |
| **Recomendado** | **✅** | Alternativa | — |

---

## 4. Estrategia integrada recomendada

### 4.1 Principios

1. **Un commit → todas las plataformas**: el pipeline CI/CD debe generar y distribuir automáticamente todos los artefactos tras merge a `main`
2. **Sin fricción para testers**: instalación simple, sin UDID registration, sin cuentas adicionales complejas
3. **Consistencia de stack**: priorizar herramientas ya usadas (AWS, GitHub, Telegram)
4. **Escalabilidad**: el mismo canal debe poder usarse de F&F → Beta abierta → Producción

### 4.2 Infraestructura necesaria

| Componente | Descripción | Responsable |
|------------|-------------|-------------|
| Firebase Project | 1 proyecto con 3 apps Android (client, business, delivery) | DevOps |
| Apple Developer Program | Cuenta para TestFlight + certificados iOS | Fundador/PO |
| AWS S3 Bucket | `intrale-web-staging` con CloudFront distribution | DevOps |
| CloudFront Distribution | CDN + signed URLs para web | DevOps |
| GitHub Releases | En repo `intrale/platform` (privado) | Automático |
| Mac runner CI | Para builds iOS (GitHub Actions o Codemagic) | DevOps |

### 4.3 Variables de entorno requeridas en GitHub Actions

```yaml
# Firebase App Distribution (Android)
FIREBASE_TOKEN:         # firebase login:ci → token
FIREBASE_APP_ID_CLIENT:  # App ID del flavor client
FIREBASE_APP_ID_BUSINESS: # App ID del flavor business
FIREBASE_APP_ID_DELIVERY: # App ID del flavor delivery
FIREBASE_TESTERS_GROUP: # Nombre del grupo (ej: "friends-family")

# iOS (TestFlight)
APP_STORE_CONNECT_API_KEY_ID:
APP_STORE_CONNECT_API_ISSUER:
APP_STORE_CONNECT_API_KEY_CONTENT: # Clave P8 en base64
TEAM_ID:
PROVISIONING_PROFILE_BASE64:
CERTIFICATE_BASE64:

# Web/Wasm (AWS S3)
AWS_S3_BUCKET_WEB: intrale-web-staging
AWS_CLOUDFRONT_DISTRIBUTION_ID:
# (reutiliza AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY existentes)
```

---

## 5. Diagrama de flujo: commit → distribución → notificación

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PUSH a main (o PR mergeado)                                             │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                   GitHub Actions: distribute.yml
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
   │   Android   │   │   Desktop    │   │  Web/Wasm    │
   │   (Ubuntu)  │   │  (Windows)   │   │  (Ubuntu)    │
   └──────┬──────┘   └──────┬───────┘   └──────┬───────┘
          │                  │                  │
   ./gradlew assemble  ./gradlew package  ./gradlew wasmJsBrowser
   (3 flavors)         (Msi/Deb)          ProductionWebpack
          │                  │                  │
          ▼                  ▼                  ▼
   Firebase App Dist.  GitHub Release     aws s3 sync
   (client/biz/deliv)  (assets upload)    + CF invalidate
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                    ┌────────▼────────┐
                    │   iOS (macOS)   │
                    │  runner/Codemagic│
                    └────────┬────────┘
                             │
                    ./gradlew iosX64
                    + Xcode Archive
                    + fastlane pilot
                             │
                    TestFlight upload
                             │
                    ┌────────▼────────────────────────────────┐
                    │   Notificación Telegram (notify-telegram) │
                    │   "🚀 Build v1.0.X distribuido:          │
                    │    Android: [link Firebase]               │
                    │    iOS: TestFlight (actualizar app)        │
                    │    Desktop: [link GitHub Release]          │
                    │    Web: [URL CloudFront]"                  │
                    └─────────────────────────────────────────┘
```

### Nuevo workflow propuesto: `.github/workflows/distribute.yml`

```yaml
name: Friends & Family Distribution

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      release_notes:
        description: 'Notas de release'
        required: false
        default: 'Build automático'

jobs:
  android:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        flavor: [client, business, delivery]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - name: Build APK ${{ matrix.flavor }}
        run: ./gradlew :app:composeApp:assemble${{ matrix.flavor | capitalize }}Debug
      - name: Upload to Firebase App Distribution
        uses: wzieba/Firebase-Distribution-Github-Action@v1
        with:
          appId: ${{ secrets[format('FIREBASE_APP_ID_{0}', matrix.flavor | upper)] }}
          token: ${{ secrets.FIREBASE_TOKEN }}
          groups: ${{ secrets.FIREBASE_TESTERS_GROUP }}
          releaseNotes: ${{ github.event.inputs.release_notes || github.event.head_commit.message }}
          file: app/composeApp/build/outputs/apk/${{ matrix.flavor }}/debug/composeApp-${{ matrix.flavor }}-debug.apk

  desktop:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - name: Build MSI installer
        run: ./gradlew :app:composeApp:packageMsi
      - name: Create/Update GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ github.run_number }}
          name: "Friends & Family Build ${{ github.run_number }}"
          files: app/composeApp/build/compose/binaries/main/msi/*.msi
          prerelease: true
          body: ${{ github.event.inputs.release_notes || github.event.head_commit.message }}

  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - name: Build Web/Wasm
        run: ./gradlew :app:composeApp:wasmJsBrowserProductionWebpack
      - name: Deploy to S3
        run: |
          aws s3 sync app/composeApp/build/dist/wasmJs/productionExecutable/ \
            s3://${{ secrets.AWS_S3_BUCKET_WEB }}/ --delete
      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.AWS_CLOUDFRONT_DISTRIBUTION_ID }} \
            --paths "/*"
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: us-east-1

  ios:
    runs-on: macos-latest  # Requiere runner macOS (pago en GitHub)
    steps:
      - uses: actions/checkout@v4
      - name: Install KMP toolchain
        run: brew install kotlin
      - name: Build iOS framework
        run: ./gradlew :app:composeApp:linkReleaseFrameworkIosArm64
      - name: Upload to TestFlight
        uses: apple-actions/upload-testflight-build@v1
        with:
          app-path: app/iosApp/build/iosApp.ipa
          issuer-id: ${{ secrets.APP_STORE_CONNECT_API_ISSUER }}
          api-key-id: ${{ secrets.APP_STORE_CONNECT_API_KEY_ID }}
          api-private-key: ${{ secrets.APP_STORE_CONNECT_API_KEY_CONTENT }}

  notify:
    needs: [android, desktop, web]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - name: Notify Telegram
        run: |
          curl -s -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d chat_id="${{ secrets.TELEGRAM_CHAT_ID }}" \
            -d text="🚀 Build Friends & Family #${{ github.run_number }} distribuido
          Android: Firebase App Distribution (revisa tu email)
          Desktop: https://github.com/intrale/platform/releases
          Web: ${{ secrets.WEB_STAGING_URL }}
          iOS: TestFlight (actualizar la app)

          Commit: ${{ github.event.head_commit.message }}"
```

---

## 6. Checklists de configuración por plataforma

### Android — Firebase App Distribution

- [ ] Crear proyecto Firebase en [console.firebase.google.com](https://console.firebase.google.com)
- [ ] Registrar 3 apps Android: `com.intrale.app.client`, `com.intrale.app.business`, `com.intrale.app.delivery`
- [ ] Bajar `google-services.json` para cada app (aunque no se use Firebase SDK, se necesita para la distribución)
- [ ] Crear grupo de testers "friends-family" en Firebase App Distribution
- [ ] Agregar emails de testers al grupo
- [ ] Ejecutar `firebase login:ci` → copiar token
- [ ] Agregar secrets en GitHub: `FIREBASE_TOKEN`, `FIREBASE_APP_ID_CLIENT`, `FIREBASE_APP_ID_BUSINESS`, `FIREBASE_APP_ID_DELIVERY`, `FIREBASE_TESTERS_GROUP`
- [ ] Crear workflow `.github/workflows/distribute.yml` con el job `android`
- [ ] Verificar build: `./gradlew :app:composeApp:assembleClientDebug`
- [ ] Test end-to-end: hacer push → verificar email de tester

### iOS — TestFlight

- [ ] Registrar en [Apple Developer Program](https://developer.apple.com/programs/) ($99/año)
- [ ] Crear App IDs en App Store Connect: uno por cada flavor (3 apps)
- [ ] Generar certificado de distribución (Distribution Certificate)
- [ ] Crear Provisioning Profile para App Store (para TestFlight)
- [ ] Crear App Store Connect API Key (para automatización con fastlane/pilot)
- [ ] Instalar `fastlane` en el CI runner macOS: `gem install fastlane`
- [ ] Configurar `fastlane/Fastfile` con lane `beta`
- [ ] Agregar secrets: `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER`, `APP_STORE_CONNECT_API_KEY_CONTENT`, `TEAM_ID`
- [ ] Invitar testers internos (hasta 100) en App Store Connect → TestFlight
- [ ] Resolver bloqueador: definir runner macOS (GitHub Actions `macos-latest` o Codemagic)
- [ ] Test: build manual en Mac → archive → upload a TestFlight → verificar aparece en TestFlight

### Desktop/JVM — GitHub Releases

- [ ] Verificar que `packageVersion` es dinámico o se incrementa por CI (build number)
- [ ] Crear workflow con job `desktop` (Windows runner para MSI, Linux runner para Deb)
- [ ] Verificar comando: `./gradlew :app:composeApp:packageMsi`
- [ ] Agregar GitHub Action `softprops/action-gh-release@v2`
- [ ] Configurar release como `prerelease: true` hasta estar listo para producción
- [ ] Crear URL de descarga directa (sin autenticación GitHub) o dar acceso al repo a testers
- [ ] Opcional: configurar notificación Telegram con link de descarga
- [ ] Test: merge a main → verificar release creado con assets

### Web/Wasm — AWS S3 + CloudFront

- [ ] Crear S3 bucket `intrale-web-staging` (región: us-east-1, consistente con Lambda)
- [ ] Configurar bucket para hosting estático (Block public access: OFF, Policy: CloudFront only)
- [ ] Crear CloudFront Distribution apuntando al bucket
- [ ] Configurar signed URLs o Cognito-based auth para proteger el acceso (según nivel de privacidad requerido)
- [ ] Agregar `AWS_S3_BUCKET_WEB` y `AWS_CLOUDFRONT_DISTRIBUTION_ID` en GitHub Secrets
- [ ] Agregar job `web` al workflow de distribución
- [ ] Verificar comando: `./gradlew :app:composeApp:wasmJsBrowserProductionWebpack`
- [ ] Test: merge a main → verificar archivos en S3 → abrir URL CloudFront

---

## 7. Estimación de esfuerzo

### Priorización sugerida (sprint)

| Prioridad | Plataforma | Esfuerzo | Bloqueadores |
|-----------|------------|----------|--------------|
| 1 | Web/Wasm | **S (1-2 días)** | Ninguno |
| 2 | Android | **M (2-3 días)** | Crear proyecto Firebase |
| 3 | Desktop/JVM | **S (1 día)** | Ninguno |
| 4 | iOS | **L (3-5 días)** | Developer Program ($99/año) + Mac runner |

**Total estimado:**
- Web + Android + Desktop: ~5-7 días (1 sprint)
- iOS: +3-5 días adicionales (bloqueado por cuenta Apple)

### Desglose por tarea

| Tarea | Esfuerzo | Tipo |
|-------|----------|------|
| Configurar Firebase + 3 apps Android | M | DevOps |
| Implementar workflow Android CI | S | DevOps |
| Crear S3 bucket + CloudFront | S | DevOps |
| Implementar workflow Web CI | S | DevOps |
| Implementar workflow Desktop CI | S | DevOps |
| Obtener Apple Developer Program | — | Admin/Decisión |
| Configurar certificados iOS + fastlane | M | DevOps |
| Implementar workflow iOS CI (Mac runner) | M | DevOps |
| Versionamiento dinámico centralizado | S | Engineering |
| Notificación Telegram integrada | S | DevOps |
| Documentación para testers (cómo instalar) | S | PO/Docs |

---

## 8. Identificación de dependencias

### Dependencias internas (bloqueantes)

| Dependencia | Descripción | Bloqueante para |
|-------------|-------------|-----------------|
| Versionamiento dinámico | `versionCode`/`versionName` deben incrementarse automáticamente en CI (actualmente hardcodeado = 1) | Android, iOS, Desktop |
| Segregación de entornos | Las apps apuntan a un único endpoint Lambda; se necesita `staging` vs `prod` | Todas las plataformas |
| Keystore Android firmado | Para distribución con firma consistente (ahora usa debug keystore) | Android (Play Store, no Firebase) |

### Dependencias externas (adquisición necesaria)

| Dependencia | Costo | Responsable | Urgencia |
|-------------|-------|-------------|----------|
| Cuenta Firebase | Gratuito | DevOps | Alta (bloquea Android) |
| Apple Developer Program | $99/año | Fundador/PO | Media (bloquea iOS) |
| Mac runner o servicio CI (Codemagic) | $0-50/mes | DevOps | Media (bloquea iOS) |
| Dominio/URL staging web | Opcional | DevOps | Baja |

### Dependencias de terceros ya resueltas

- ✅ AWS account (activa, secretos configurados en GitHub)
- ✅ GitHub Actions (configurado, workflows `main.yml` y `pr-checks.yml` funcionando)
- ✅ Telegram Bot (activo, webhook configurado)
- ✅ `gh` CLI (disponible en el entorno de desarrollo)

---

## 9. Escalabilidad: F&F → Beta abierta → Producción

```
Fase 1: Friends & Family (actual)
├── Android: Firebase App Distribution (invite only)
├── iOS: TestFlight (internal, <100 testers)
├── Desktop: GitHub Releases (prerelease)
└── Web: S3/CloudFront con signed URLs

Fase 2: Beta abierta
├── Android: Google Play Internal Testing → Open Testing (Play Store)
├── iOS: TestFlight external (hasta 10.000, con revisión Apple)
├── Desktop: GitHub Releases públicos o auto-update server
└── Web: CloudFront pública (sin signed URLs)

Fase 3: Producción
├── Android: Google Play Store (producción)
├── iOS: App Store (revisión completa Apple)
├── Desktop: Sitio de descarga oficial + auto-update
└── Web: Dominio propio con CDN global
```

**Nota:** La migración de F&F a Beta y Producción no requiere cambios en el pipeline CI/CD, solo en los destinos de distribución. El workflow `.github/workflows/distribute.yml` propuesto es compatible con todas las fases.

---

## 10. Decisiones pendientes (para PO + Fundador)

1. **¿Adquirir Apple Developer Program ($99/año)?** — Bloquea distribución iOS. Necesaria si iOS es prioritario en F&F.
2. **¿Mac runner de GitHub Actions vs Codemagic Free Tier?** — GitHub macOS runner cuesta ~$0.08/min; Codemagic ofrece 500 min/mes gratis.
3. **¿Proteger la URL web con autenticación?** — CloudFront signed URLs (más seguro) vs URL pública con seguridad por oscuridad (más simple para testers).
4. **¿Versionamiento semántico manual o automático?** — Recomendar automático por CI: `versionCode = github.run_number`, `versionName = "1.0.${github.run_number}"`.
5. **¿Cuántos testers F&F?** — Determina si Firebase free tier (1.000) y TestFlight internal (100) son suficientes.

---

*Documento generado automáticamente como parte de la investigación del Issue #1269.*
*Revisado por: Claude Opus 4.6 (agente #2, SPR-004)*
