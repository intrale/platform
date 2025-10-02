# Refinamiento – Issue #373

_Repositorio: intrale/platform_

## Objetivo
Definir un runbook operativo para crear manualmente la tabla `branding` de DynamoDB en AWS Console, asegurando que cualquier operador pueda provisionarla de forma repetible en cada ambiente (dev/stg/prd).

## Contexto
- La tabla respaldará los endpoints de branding descritos en la iniciativa H2.x y debe existir antes de desplegar el backend.
- El ADR de #372 establece la estructura single-table; este runbook traduce esa decisión en pasos accionables dentro de la consola.
- Otros issues (ej. #376 seeds, #378 OpenAPI draft) dependen de que la tabla esté disponible con claves correctas y protecciones activadas.

## Cambios requeridos
- Crear `docs/runbooks/dynamodb-branding-manual.md` con las secciones:
  1. **Prerequisitos**: cuenta AWS, permisos `dynamodb:*` sobre tabla, región objetivo (usar `us-east-1` como ejemplo y aclarar que puede variar por ambiente), y confirmar naming convention `branding-<env>`.
  2. **Pasos en consola**:
     - Navegar a DynamoDB → Create table.
     - Completar nombre `branding-dev` (parametrizable) y claves: Partition key `PK` (String), Sort key `SK` (String).
     - Seleccionar `On-demand` billing mode.
     - Activar `Point-in-Time Recovery` y `Deletion protection`.
     - Configurar `Encryption` con AWS owned CMK (default) y registrar cómo cambiarlo si compliance lo exige.
     - (Opcional) Definir `TTL` en atributo `expiresAt` pero dejarlo deshabilitado hasta que #376 confirme uso.
     - Agregar tags sugeridas (`service=branding`, `owner=platform`, `environment=<env>`).
  3. **Verificación post-creación**:
     - Revisar pestaña `Indexes` (debe mostrar sólo la clave primaria; GSI quedará documentado en #375 si se requiere).
     - Ejecutar `Explore items` → `Create item` en modo JSON con plantilla base del marcador publicado para validar estructura.
     - Registrar ARN de la tabla y compartirlo vía parámetro SSM (`/platform/branding/<env>/tableArn`).
  4. **Checklist de salida** con capturas/opciones a validar (estado `Active`, PITR `Enabled`, protección `Enabled`).
- Incluir notas para ambientes adicionales (staging, producción) y la convención de sufijos.
- Añadir un apéndice con troubleshooting común (errores de permisos, regiones equivocadas, naming conflict) y enlaces a documentación oficial de AWS.

## Criterios de aceptación
- [ ] El runbook está publicado en `docs/runbooks/dynamodb-branding-manual.md` con pasos numerados y checklist final.
- [ ] Describe explícitamente claves (`PK`, `SK`) y configuraciones obligatorias (On-demand, PITR, Deletion protection, tags).
- [ ] Incluye sección de verificación post-creación con ejemplo JSON de marcador publicado y cómo confirmar estado `Active`.
- [ ] Señala dependencias con otros issues (GSI opcional #375, seeds #376) para mantener trazabilidad.

## Notas técnicas
- Mantener el runbook orientado a operadores (tono imperativo, pasos claros, sin asumir acceso por CLI).
- Usar tablas o bloques destacados para parámetros (`branding-dev`, `branding-stg`, `branding-prd`).
- Evitar exponer ARN reales; utilizar placeholders `<account-id>` / `<env>`.
- Agregar referencias a AWS docs (Create table, PITR) solo si ayudan al lector a profundizar.
