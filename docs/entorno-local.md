# Entorno de Desarrollo Local

Guía para correr el stack completo sin dependencia de AWS real.

## Arquitectura

```
App (Desktop/Android/Wasm)
  │
  │  http://localhost:8080  (Desktop/Wasm)
  │  http://10.0.2.2:8080   (Android emulador)
  │
  ▼
Backend Ktor/Netty (:8080)
  ├── DynamoDB Local (Docker, :8000)
  └── Moto Cognito  (Docker, :5050)
```

**DynamoDB Local** emula el servicio de base de datos NoSQL de AWS.
**Moto** emula Cognito (auth): soporta `adminInitiateAuth`, `adminCreateUser`, `getUser`, `changePassword`, `forgotPassword`, `confirmForgotPassword`, `confirmSignUp`, `adminRespondToAuthChallenge`, `adminUpdateUserAttributes`.

## Requisitos

- Docker y Docker Compose
- Java 21 (Temurin recomendado)
- Emulador Android (solo si se prueba la app Android)

## Inicio rápido

### Opción A: Scripts automatizados

**Terminal 1** — Levanta Docker + backend:

```bash
./scripts/local-up.sh
```

Esto hace todo automáticamente:
1. `docker compose up -d` (DynamoDB Local + Moto + init container)
2. Espera a que `aws-init` cree tablas, User Pool y datos seed
3. Extrae `USER_POOL_ID` y `CLIENT_ID` de los logs
4. Guarda las variables en `.env.local`
5. Arranca el backend Ktor (queda en foreground)

**Terminal 2** — Lanza la app:

```bash
./scripts/local-app.sh              # Desktop (JVM)
./scripts/local-app.sh android      # Emulador Android
./scripts/local-app.sh wasm         # Navegador (Wasm)
```

**Para parar todo** — Ctrl+C en Terminal 1, luego:

```bash
./scripts/local-down.sh
```

### Opción B: Paso a paso manual

#### 1. Levantar servicios Docker

```bash
docker compose up -d
```

Esperar a que `aws-init` termine:

```bash
docker compose logs aws-init
```

Al final debería mostrar:

```
=== Entorno local listo ===
  USER_POOL_ID=us-east-1_XXXXXXXX
  CLIENT_ID=XXXXXXXXXXXXXXXXX
```

Copiar esos dos valores.

#### 2. Levantar el backend

```bash
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
export LOCAL_MODE=true
export REGION_VALUE=us-east-1
export ACCESS_KEY_ID=local
export SECRET_ACCESS_KEY=local
export USER_POOL_ID=<valor del paso anterior>
export CLIENT_ID=<valor del paso anterior>
export DYNAMODB_ENDPOINT=http://localhost:8000
export COGNITO_ENDPOINT=http://localhost:5050

./gradlew :users:run
```

#### 3. Verificar que funciona

```bash
curl -X POST http://localhost:8080/intrale/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@intrale.com","password":"Admin1234!"}'
```

Debería retornar tokens JWT.

#### 4. Lanzar la app

Desktop:
```bash
./gradlew :app:composeApp:run -PLOCAL_BASE_URL=http://localhost:8080/
```

Android (emulador):
```bash
./gradlew :app:composeApp:installClientDebug -PLOCAL_BASE_URL=http://10.0.2.2:8080/
```

#### 5. Parar todo

```bash
docker compose down
```

## Datos seed

El script `scripts/init-local-aws.sh` crea automáticamente:

| Recurso | Detalle |
|---------|---------|
| Tabla `business` | Negocio "intrale" (state: APPROVED) |
| Tabla `users` | Usuario `admin@intrale.com` (enabled: true) |
| Tabla `userbusinessprofile` | Perfil `admin@intrale.com#intrale#DEFAULT` |
| Cognito User Pool | `intrale-local` con App Client |
| Cognito User | `admin@intrale.com` / `Admin1234!` (password temporal) |

## Variables de entorno

| Variable | Valor local | Descripción |
|----------|-------------|-------------|
| `LOCAL_MODE` | `true` | Activa `LocalJwtValidator` (sin verificación criptográfica) |
| `REGION_VALUE` | `us-east-1` | Región AWS simulada |
| `ACCESS_KEY_ID` | `local` | Credencial dummy para DynamoDB/Cognito local |
| `SECRET_ACCESS_KEY` | `local` | Credencial dummy para DynamoDB/Cognito local |
| `USER_POOL_ID` | Generado por Moto | ID del User Pool creado por `aws-init` |
| `CLIENT_ID` | Generado por Moto | ID del App Client creado por `aws-init` |
| `DYNAMODB_ENDPOINT` | `http://localhost:8000` | Override del endpoint DynamoDB |
| `COGNITO_ENDPOINT` | `http://localhost:5050` | Override del endpoint Cognito |
| `LOCAL_BASE_URL` | `http://localhost:8080/` | Gradle property para la app (desktop/wasm) |
| `LOCAL_BASE_URL` | `http://10.0.2.2:8080/` | Gradle property para la app (Android emulador) |

**Sin ninguna de estas variables seteadas, el comportamiento es idéntico al de producción.**

## Archivos involucrados

| Archivo | Rol |
|---------|-----|
| `docker-compose.yml` | Define servicios Docker (DynamoDB, Moto, init) |
| `scripts/init-local-aws.sh` | Crea tablas, User Pool y seed (corre en container) |
| `scripts/local-up.sh` | Automatiza Docker + extracción de creds + backend |
| `scripts/local-down.sh` | Detiene backend + Docker + limpia `.env.local` |
| `scripts/local-app.sh` | Lanza la app apuntando al backend local |
| `users/.../LocalJwtValidator.kt` | Valida JWT sin verificar firma (modo Moto) |
| `users/.../Modules.kt` | Endpoint overrides + binding condicional |
| `app/.../build.gradle.kts` | Soporte `LOCAL_BASE_URL` en BuildKonfig |
| `app/.../AndroidManifest.xml` | Referencia a `networkSecurityConfig` |
| `app/.../res/xml/network_security_config.xml` | Permite HTTP a 10.0.2.2 y localhost |

## Troubleshooting

### `aws-init` falla o no termina

```bash
docker compose logs aws-init
```

Verificar que DynamoDB Local y Moto estén healthy:

```bash
docker compose ps
```

### El backend no arranca

Verificar que `USER_POOL_ID` y `CLIENT_ID` estén seteados. Si se usa `local-up.sh`, se guardan en `.env.local`.

### La app Android no conecta

- Verificar que el emulador esté corriendo
- Usar `10.0.2.2` (no `localhost`) — es el alias del host desde el emulador
- `network_security_config.xml` permite cleartext solo a `10.0.2.2` y `localhost`

### JWT inválido

En modo local (`LOCAL_MODE=true`), `LocalJwtValidator` decodifica sin verificar firma. Si hay error de `ClientId invalido`, verificar que el `CLIENT_ID` coincida con el generado por Moto.
