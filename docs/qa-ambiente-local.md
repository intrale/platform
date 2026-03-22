# Ambiente Local QA — Setup y Validación E2E

Guía completa para levantar el ambiente local de pruebas end-to-end: backend + emulador Android + captura de video.

## Arquitectura del ambiente QA

```
Maestro E2E (flows YAML)
       │
       ▼
App Android (emulador virtualAndroid)
       │  http://10.0.2.2:80
       ▼
Backend Ktor (:80)
  ├── DynamoDB Local (Docker :8000)
  └── Moto Cognito   (Docker :5050)
```

## Scripts disponibles

| Script | Descripción | Uso |
|--------|-------------|-----|
| `scripts/validate-env.sh` | Verifica prerequisitos (Java, Docker, ADB, AVD) | Antes de empezar |
| `qa/scripts/qa-env-up.sh` | Levanta Docker + backend Ktor | Backend QA |
| `qa/scripts/qa-env-down.sh` | Detiene backend + Docker | Cleanup |
| `qa/scripts/backend-healthcheck.sh` | Verifica endpoints del backend | Diagnóstico |
| `qa/scripts/qa-android.sh` | Build APK + Maestro E2E + video | Tests completos |
| `qa/scripts/smoke-test.sh` | **Ciclo completo integrado** | Validación rápida |

## Inicio rápido — Ciclo completo

```bash
# Un solo comando para el ciclo completo:
bash qa/scripts/smoke-test.sh --issue 1781
```

El script ejecuta automáticamente:
1. Verificación de prerequisitos
2. Docker + backend Ktor
3. Health-check de endpoints
4. Emulador Android (con snapshot qa-ready si existe)
5. Build e instalación del APK
6. Tests Maestro con grabación de video
7. Generación de evidencia en `qa/evidence/`

## Setup paso a paso

### 1. Prerequisitos

```bash
./scripts/validate-env.sh
```

Verifica:
- **Java 21** (Temurin recomendado)
- **Docker Desktop** corriendo
- **ADB** en PATH (Android SDK Platform-Tools)
- **AVD** `virtualAndroid` configurado

Si falla, seguir la guía de [docs/entorno-local.md](entorno-local.md).

### 2. Backend local

```bash
# Levantar Docker + backend automáticamente:
bash qa/scripts/qa-env-up.sh

# Verificar que los endpoints responden:
bash qa/scripts/backend-healthcheck.sh
```

El backend queda corriendo en background. Para detenerlo:
```bash
bash qa/scripts/qa-env-down.sh
```

**Endpoints verificados por el health-check:**

| Endpoint | Método | Comportamiento esperado |
|----------|--------|------------------------|
| `/` | GET | HTTP 404 (routing activo) |
| `/intrale/signin` | POST `{}` | HTTP 400 (validación de campos) |
| `/intrale/signup` | POST `{}` | HTTP 400 (validación de campos) |
| `/intrale/profiles` | POST sin token | HTTP 401 (autenticación requerida) |
| `/intrale/searchBusinesses` | POST `{}` | HTTP 400 |

### 3. Emulador Android

#### Verificar AVD existente

```bash
emulator -list-avds
```

Debe aparecer `virtualAndroid`. Si no existe, crearlo en Android Studio:
- **Device Manager → Create Device**
- Seleccionar: **Pixel 6**, API **35** (Android 15), x86_64
- Nombre: `virtualAndroid`

#### Snapshot qa-ready (boot rápido)

Con el emulador corriendo y en estado limpio:

```bash
# Desde Android Studio: Device Manager → ⋮ → Save Snapshot → nombre: "qa-ready"
# O por línea de comando:
adb emu avd snapshot save qa-ready
```

El snapshot permite boots de ~40s vs ~130s cold boot.

Si el snapshot falla ("different AVD configuration"), borrarlo y recrearlo:
```bash
rm -rf ~/.android/avd/virtualAndroid.avd/snapshots/qa-ready
```

### 4. Tests Maestro con video

```bash
bash qa/scripts/qa-android.sh
```

El script:
1. Arranca el emulador (si no está corriendo)
2. Compila el APK `client debug`
3. Instala el APK
4. Inicia `screenrecord` (720x1280, 2Mbps)
5. Ejecuta los flows YAML de `.maestro/flows/`
6. Detiene la grabación y extrae el video
7. Genera reporte JUnit XML

Videos guardados en: `qa/recordings/maestro-shard-5554.mp4`

### 5. Evidencia completa

```bash
bash qa/scripts/collect-evidence.sh
```

Estructura de evidencia en `qa/evidence/`:
```
qa/evidence/
├── YYYY-MM-DD_HH-MM-SS-issueN/
│   ├── summary.md
│   ├── smoke-test.log
│   ├── healthcheck.log
│   ├── maestro-output.log
│   ├── maestro-results.xml
│   └── smoke-test.mp4
└── latest/           ← copia del último run
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `QA_BASE_URL` | `http://localhost:80` | URL del backend local |
| `QA_SHARDS` | `1` | Emuladores paralelos (1=liviano, 3=paralelo) |
| `QA_AVD_MEMORY` | `1536` | RAM por emulador (MB) |
| `QA_AVD_CORES` | `2` | Cores por emulador |
| `QA_NO_AFFINITY` | `0` | Deshabilitar CPU affinity (debug) |

## Tiempos de referencia

| Paso | Modo snapshot | Cold boot |
|------|--------------|-----------|
| Prerequisitos | ~5s | ~5s |
| Backend up (Docker + Ktor) | ~60s | ~90s |
| Health-check | ~5s | ~5s |
| Emulador boot | ~40s | ~130s |
| Build APK | ~90s | ~90s |
| Tests Maestro (3 flows) | ~60s | ~60s |
| **Total** | **~4.5 min** | **~6.5 min** |

Con snapshot `qa-ready`, el ciclo completo está dentro del objetivo de **10 minutos**.

## Troubleshooting

### Backend no levanta

```bash
# Ver logs de Docker
docker compose logs aws-init

# Verificar servicios
docker compose ps

# Si aws-init no terminó, reiniciar:
docker compose down && docker compose up -d
```

### Health-check falla

```bash
# Verificar que el backend responde manualmente
curl -s -o /dev/null -w '%{http_code}' \
    -X POST http://localhost:80/intrale/signin \
    -H 'Content-Type: application/json' \
    -d '{}'
# Esperado: 400
```

### Emulador no arranca

```bash
# Verificar AVDs disponibles
emulator -list-avds

# Si el snapshot falla, borrar y recrear
rm -rf ~/.android/avd/virtualAndroid.avd/snapshots/qa-ready

# Arrancar manualmente para diagnóstico (con ventana visible)
emulator -avd virtualAndroid -gpu auto
```

### Video vacío o corrupto

Si el video extraído es 0 bytes:
1. Verificar que `screenrecord` esté disponible en el emulador: `adb shell which screenrecord`
2. Verificar espacio en `/sdcard`: `adb shell df /sdcard`
3. El path `/sdcard/smoke-test.mp4` es fijo — si hay permisos, usar `/data/local/tmp/`

### APK no instala

```bash
# Verificar que el emulador está listo
adb devices

# Verificar que el emulador acepta la app
adb -s emulator-5554 install -r path/to/app.apk
```

## Integración con /qa

El agente `/qa` usa `qa-android.sh` internamente. Para ejecutar el ciclo completo con el agente:

```
/qa android
/qa all
```

Para validar un issue específico con evidencia:
```
/qa validate 1781
```

## Flujos Maestro disponibles

| Flow | Descripción | Path |
|------|-------------|------|
| `login.yaml` | Login con credenciales seed | `.maestro/flows/login.yaml` |
| `signup.yaml` | Registro de usuario nuevo | `.maestro/flows/signup.yaml` |
| `navigation.yaml` | Navegación entre pantallas | `.maestro/flows/navigation.yaml` |

Para agregar nuevos flows, ver [docs/qa-e2e.md](qa-e2e.md#agregar-nuevos-tests).
