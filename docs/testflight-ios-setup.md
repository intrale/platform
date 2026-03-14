# Guía de Setup — TestFlight iOS (3 Flavors)

**Versión:** 1.0
**Issue:** [#1465](https://github.com/intrale/platform/issues/1465)
**Audiencia:** DevOps / Fundador
**Prerequisito:** Apple Developer Program activo ($99/año)

---

## Descripción general

Esta guía detalla los pasos necesarios para configurar TestFlight como canal de distribución
Friends & Family para las 3 apps iOS de Intrale (client, business, delivery).

El pipeline CI/CD (`.github/workflows/distribute-ios.yml`) está listo. Solo se necesita
completar la configuración en Apple y cargar los secrets en GitHub.

---

## Paso 1: Registrar en Apple Developer Program

1. Ir a [developer.apple.com/programs](https://developer.apple.com/programs/)
2. Hacer clic en **"Enroll"**
3. Iniciar sesión con el Apple ID corporativo
4. Seleccionar **"Organization"** como tipo de cuenta
5. Completar el proceso de pago ($99 USD/año)
6. Esperar la aprobación (normalmente 24-48 horas)

Una vez aprobado, acceder a [appstoreconnect.apple.com](https://appstoreconnect.apple.com).

---

## Paso 2: Crear las 3 Apps en App Store Connect

Para cada uno de los 3 flavors, crear una app en App Store Connect:

| Flavor | Bundle ID | Nombre en App Store Connect |
|--------|-----------|----------------------------|
| client | `com.intrale.app.client` | Intrale |
| business | `com.intrale.app.business` | Intrale Negocios |
| delivery | `com.intrale.app.delivery` | Intrale Repartos |

### Para cada app:
1. En App Store Connect → **"My Apps"** → **"+"** → **"New App"**
2. **Platform:** iOS
3. **Name:** (ver tabla)
4. **Primary Language:** Spanish (Mexico) o Spanish (Spain)
5. **Bundle ID:** Seleccionar o crear (ver tabla)
6. **SKU:** `intrale-client` / `intrale-business` / `intrale-delivery`
7. Hacer clic en **"Create"**

---

## Paso 3: Generar Certificado de Distribución

Un solo certificado sirve para las 3 apps.

### En Mac con Xcode:

1. Abrir **Keychain Access** → **Certificate Assistant** → **Request a Certificate from a Certificate Authority**
2. Ingresar email corporativo, seleccionar **"Save to disk"**
3. Ir a [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates)
4. **"+"** → **"Apple Distribution"**
5. Subir el `.certSigningRequest` generado
6. Descargar el `.cer` generado y hacer doble clic para instalarlo en Keychain

### Exportar el certificado como .p12:
1. En **Keychain Access** → buscar "Apple Distribution: [nombre org]"
2. Click derecho → **"Export"**
3. Formato: `.p12`
4. Establecer una contraseña segura (guardar para `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`)

### Convertir a base64 para GitHub Secrets:
```bash
base64 -i certificate.p12 -o certificate_b64.txt
# El contenido de certificate_b64.txt → IOS_DISTRIBUTION_CERTIFICATE_BASE64
```

---

## Paso 4: Crear Provisioning Profiles

Un profile por flavor (3 en total). Tipo: **App Store**.

### Para cada flavor:
1. Ir a [developer.apple.com/account/resources/profiles](https://developer.apple.com/account/resources/profiles)
2. **"+"** → **"App Store Connect"** (bajo Distribution)
3. **App ID:** seleccionar el bundle ID correspondiente
4. **Certificate:** seleccionar el Distribution Certificate creado en Paso 3
5. **Profile Name:** `Intrale Client AppStore` / `Intrale Business AppStore` / `Intrale Delivery AppStore`
6. Descargar el `.mobileprovision`

### Convertir a base64:
```bash
# Client
base64 -i Intrale_Client_AppStore.mobileprovision -o client_profile_b64.txt
# → IOS_PROVISIONING_PROFILE_CLIENT_BASE64

# Business
base64 -i Intrale_Business_AppStore.mobileprovision -o business_profile_b64.txt
# → IOS_PROVISIONING_PROFILE_BUSINESS_BASE64

# Delivery
base64 -i Intrale_Delivery_AppStore.mobileprovision -o delivery_profile_b64.txt
# → IOS_PROVISIONING_PROFILE_DELIVERY_BASE64
```

---

## Paso 5: Crear App Store Connect API Key

Permite que fastlane suba builds a TestFlight sin usar usuario/contraseña.

1. En App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**
2. **"+"** → crear nueva key
3. **Name:** `Intrale CI/CD`
4. **Access:** Developer (suficiente para TestFlight)
5. Descargar el archivo `.p8` (solo se puede descargar una vez)
6. Anotar:
   - **Key ID** → `APP_STORE_CONNECT_API_KEY_ID`
   - **Issuer ID** (arriba de la tabla) → `APP_STORE_CONNECT_API_ISSUER`

### Convertir la clave .p8 a base64:
```bash
base64 -i AuthKey_XXXXXXXXXX.p8 -o api_key_b64.txt
# El contenido → APP_STORE_CONNECT_API_KEY_CONTENT
```

---

## Paso 6: Obtener el Team ID

1. En [developer.apple.com/account](https://developer.apple.com/account)
2. Sección **"Membership"**
3. Copiar **"Team ID"** (formato: `XXXXXXXXXX`, 10 caracteres alfanuméricos)
4. → `IOS_TEAM_ID`

---

## Paso 7: Configurar Secrets en GitHub

Ir a **github.com/intrale/platform → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Descripción | Cómo obtenerlo |
|--------|-------------|----------------|
| `IOS_DISTRIBUTION_CERTIFICATE_BASE64` | Certificado .p12 en base64 | Paso 3 |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | Contraseña del .p12 | Paso 3 |
| `IOS_PROVISIONING_PROFILE_CLIENT_BASE64` | Profile client en base64 | Paso 4 |
| `IOS_PROVISIONING_PROFILE_BUSINESS_BASE64` | Profile business en base64 | Paso 4 |
| `IOS_PROVISIONING_PROFILE_DELIVERY_BASE64` | Profile delivery en base64 | Paso 4 |
| `APP_STORE_CONNECT_API_KEY_ID` | Key ID de la API Key | Paso 5 |
| `APP_STORE_CONNECT_API_ISSUER` | Issuer ID de la API Key | Paso 5 |
| `APP_STORE_CONNECT_API_KEY_CONTENT` | Clave .p8 en base64 | Paso 5 |
| `IOS_TEAM_ID` | Team ID del Developer Program | Paso 6 |
| `IOS_KEYCHAIN_PASSWORD` | Contraseña temporal para keychain CI | Generar: `openssl rand -base64 32` |

> `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` ya deben estar configurados (se usan para notificaciones).

---

## Paso 8: Configurar el proyecto Xcode (requiere Mac)

El proyecto Xcode en `app/iosApp/` necesita ser configurado para las 3 apps.
Este paso requiere Mac con Xcode instalado.

### Prerequisitos en Mac:
```bash
# Instalar Ruby bundler
gem install bundler

# Instalar dependencias fastlane
cd app/iosApp
bundle install

# Verificar fastlane
bundle exec fastlane --version
```

### Configurar schemes Xcode:
En Xcode, para cada flavor, el scheme debe coincidir con los nombres definidos en el `Fastfile`:
- Scheme `Intrale` → `com.intrale.app.client`
- Scheme `Intrale Negocios` → `com.intrale.app.business`
- Scheme `Intrale Repartos` → `com.intrale.app.delivery`

---

## Paso 9: Ejecutar el pipeline

Una vez configurados todos los secrets:

1. Ir a **github.com/intrale/platform → Actions → "Distribución iOS — TestFlight (3 Flavors)"**
2. **"Run workflow"**
3. Seleccionar `flavor`: `all` (o uno específico para testear)
4. Ingresar `release_notes`: `"Build inicial Friends & Family"`
5. Hacer clic en **"Run workflow"**

El pipeline:
- Ejecuta en runner macOS (~15-20 minutos)
- Compila el framework KMP (`linkReleaseFrameworkIosArm64`)
- Instala certificado y provisioning profile
- Compila con `gym` y sube con `pilot` via fastlane
- Notifica por Telegram con el resultado

---

## Paso 10: Invitar testers a TestFlight

1. En App Store Connect → seleccionar la app → **TestFlight** → **Internal Testing**
2. **"+"** junto a "App Store Connect Users"
3. Invitar emails del equipo (hasta 100 testers internos sin revisión de Apple)
4. Los testers recibirán email de `noreply@email.apple.com`
5. Ver guía de instalación para testers: `docs/testflight-ios-testers.md`

Para **testers externos** (hasta 10.000):
1. TestFlight → **External Testing** → **"+"**
2. Crear un grupo (ej: "Friends & Family")
3. Agregar emails
4. Enviar a revisión beta de Apple (~24-48 horas)

---

## Estimación de costos del runner macOS

| Runner | Costo | Límite | Recomendación |
|--------|-------|--------|---------------|
| GitHub Actions `macos-latest` | ~$0.08/min | Sin límite (pago) | Para builds frecuentes |
| Codemagic Free Tier | Gratuito | 500 min/mes | Para F&F con builds esporádicos |

Para la fase F&F (builds esporádicos), **Codemagic Free Tier** es suficiente.
Ver [codemagic.io](https://codemagic.io) para configurar el pipeline como alternativa.

---

## Troubleshooting

### Error: "No matching provisioning profiles found"
- Verificar que el Bundle ID en Xcode coincide exactamente con el del provisioning profile
- Regenerar el provisioning profile si el certificado fue renovado

### Error: "Code signing is required for product type 'Application'"
- El certificado de distribución no está instalado correctamente en el keychain del CI
- Verificar que `IOS_DISTRIBUTION_CERTIFICATE_BASE64` es correcto (no tiene saltos de línea extra)

### Error: "Invalid credentials" en fastlane pilot
- Verificar que `APP_STORE_CONNECT_API_KEY_CONTENT` es el .p8 completo en base64 (sin `-----BEGIN PRIVATE KEY-----`)
- La API Key debe tener permisos de **Developer** o superior

### Error: "This app cannot be installed on this device"
- Verificar que el dispositivo del tester tiene iOS 16+
- Para TestFlight interno, el tester debe aceptar la invitación primero

---

## Checklist de verificación

- [ ] Apple Developer Program activo
- [ ] 3 apps creadas en App Store Connect (client, business, delivery)
- [ ] Certificado de distribución generado y exportado como .p12
- [ ] 3 Provisioning Profiles (App Store) generados
- [ ] App Store Connect API Key creada y archivo .p8 descargado
- [ ] Team ID obtenido
- [ ] 10 GitHub Secrets configurados (ver tabla en Paso 7)
- [ ] Proyecto Xcode configurado con los 3 schemes (requiere Mac)
- [ ] Pipeline ejecutado exitosamente al menos una vez
- [ ] Al menos 1 tester interno invitado y con la app instalada

---

*Documento mantenido por el equipo de Intrale Platform.*
*Última actualización: 2026-03-14*
*Ver también: `docs/testflight-ios-testers.md` (guía para testers)*
