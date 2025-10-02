# Refinamiento – Issue #377

_Repositorio: intrale/platform_

## Objetivo
Establecer la estrategia para correr DynamoDB Local en desarrollo/CI y cubrir el repositorio de branding con pruebas automatizadas que verifiquen operaciones de lectura/escritura.

## Contexto
- Los módulos existentes (`backend`, `users`) aún no contemplan una tabla de branding; se necesita infraestructura local para iterar sin impactar AWS real.
- El script de seeds (#376) debe reutilizarse contra un endpoint local para smoke tests y pipelines.
- El backend se ejecuta con Gradle/Ktor y los tests actuales viven en `backend/src/test/kotlin`; hay que definir dónde agregar las pruebas del repositorio de branding.

## Cambios requeridos
- Añadir infraestructura local:
  - Crear `tools/docker/dynamodb-local.yml` (o ampliar un compose existente) con servicio `dynamodb` usando imagen `amazon/dynamodb-local`, puerto `8000`, volumen temporal y variables (`-jar DynamoDBLocal.jar -inMemory -sharedDb`).
  - Documentar comando de arranque: `docker compose -f tools/docker/dynamodb-local.yml up -d`.
- Ajustes en build/test:
  - Incorporar un task Gradle (`backend:dynamodbLocalStart` / `Stop`) o hooks en tests para levantar el contenedor (usando Testcontainers o `Exec` + `ProcessBuilder`).
  - Configurar tests para apuntar a `http://localhost:8000` mediante variable `DYNAMODB_ENDPOINT_OVERRIDE` o similar.
  - Asegurar que `./gradlew backend:test` arranque y detenga Dynamo local automáticamente en CI.
- Implementar pruebas del repositorio:
  - Crear paquete `backend/src/main/kotlin/ar/com/intrale/branding/` con interfaces `BrandingRepository` (planificado en otros issues) y `DynamoBrandingRepository` (implementación). Este issue debe definir qué escenarios cubrirán las pruebas aunque la implementación llegue luego.
  - Escribir tests en `backend/src/test/kotlin/ar/com/intrale/branding/DynamoBrandingRepositoryTest.kt` que validen:
    - Inserción/actualización de drafts (`putDraft`), incluyendo `ConditionExpression` para evitar sobrescrituras.
    - Publicación (actualiza marcador y theme en transacción) y rollback.
    - Lectura de tema publicado y listado de drafts.
    - Manejo de errores (conflictos de versión, item inexistente).
  - Reutilizar seeds definidos en #376 para poblar datos iniciales durante `@BeforeEach`.
- Actualizar documentación de desarrolladores (`docs/runbooks/dynamodb-branding-seed.md` o nuevo `docs/engineering/dynamodb-local.md`) con instrucciones para correr la pila local y ejecutar tests.

## Criterios de aceptación
- [ ] Existe definición de docker-compose (o Testcontainers equivalente) para DynamoDB Local versionada en `tools/docker/dynamodb-local.yml`.
- [ ] Los tests del backend pueden ejecutarse contra Dynamo local sin requerir AWS (comando documentado y automatizado en Gradle/CI).
- [ ] Se describen claramente los casos de prueba obligatorios para el repositorio de branding (draft, publish, rollback, lecturas).
- [ ] La documentación explica cómo iniciar/parar Dynamo local y cómo reutilizar seeds/fixtures.

## Notas técnicas
- Evaluar usar Testcontainers (JVM) para evitar dependencias externas en CI; en caso de usar docker-compose, asegurar limpieza (`docker compose down -v`).
- Configurar tabla local via `CreateTable` al inicio de las pruebas (mismo esquema que runbook #373) usando SDK o AWS CLI.
- Evitar puertos hardcodeados en tests; permitir override por variable (`DYNAMODB_LOCAL_PORT`).
- Incluir recomendaciones para tiempos de espera y retries en pruebas (Dynamo local puede tardar unos segundos en estar listo).
