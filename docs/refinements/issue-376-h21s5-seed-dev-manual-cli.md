# Refinamiento – Issue #376

_Repositorio: intrale/platform_

## Objetivo
Definir cómo poblar datos de desarrollo para la tabla `branding`, ofreciendo tanto un procedimiento manual en AWS Console como un script CLI reproducible que cargue temas de ejemplo.

## Contexto
- Tras crear la tabla (issue #373) los equipos necesitan datos de referencia para probar endpoints (`/branding/{businessId}/draft`, publish, etc.).
- El ADR de #372 describe estructura y tipos de ítems; este refinamiento debe convertirlo en seeds tangibles.
- Los módulos `buildSrc` y `app` ya consumen branding dinámico; contar con datos en dev acelera validaciones end-to-end y smoke tests.

## Cambios requeridos
- Documentar en `docs/runbooks/dynamodb-branding-seed.md` (nuevo) dos secciones principales:
  1. **Carga manual (AWS Console)**
     - Precondiciones: tabla `branding-dev` existente, usuario con permisos `PutItem`/`BatchWriteItem`.
     - Pasos para insertar:
       - Ítem marcador publicado (`PK = BUS#intrale`, `SK = PUBLISHED`, `type = PUBLISHED_MARKER`, `version = 1`, timestamps).
       - Ítem `THEME` publicado `version=1` con `status = published`, `metadata.palette`, `assets` y `schemaVersion=1`.
       - Ítem `THEME` draft `version=2` con cambios visibles (colores distintos) y `status = draft`.
       - Asset de ejemplo (`PK = ASSET#logo-intrale`, `SK = META`, `assetType = logo`, `uri = s3://...` placeholder).
     - Checklist para validar: `Query` por `PK = BUS#intrale` retorna 3 ítems, published marker apunta a versión 1.
  2. **Script CLI**
     - Crear script en `tools/branding_seed_dev.py` (o `.sh`) que use AWS CLI/SDK para ejecutar `batch-write-item` con los mismos ítems.
     - Parámetros: `--table-name`, `--region`, `--profile` opcional, bandera `--reset` para borrar ítems previos (`delete-item` condicional).
     - Incluir manejo de errores y mensajes claros (`print`/`logging`) en Español.
     - Documentar dependencias (Python 3 + boto3 o AWS CLI v2) y ejemplos de ejecución:
       ```bash
       python tools/branding_seed_dev.py --table-name branding-dev --region us-east-1
       ```
- Indicar cómo extender seeds para nuevos negocios (`BUS#acme`) reutilizando la plantilla.
- Añadir sección "Datos esperados" describiendo qué atributos debería leer el backend tras correr el seed (ej. `publishedAt`, `metadata.palette.primary`).
- Referenciar a #377 para reutilizar el script contra DynamoDB Local (`--endpoint-url http://localhost:8000`).

## Criterios de aceptación
- [ ] Existe documentación en `docs/runbooks/dynamodb-branding-seed.md` cubriendo guía manual y script CLI.
- [ ] El script propuesto acepta parámetros de tabla/región y puede apuntar a endpoints personalizados (local/remote).
- [ ] Los ejemplos de datos incluyen al menos un tema publicado, un draft y un asset vinculado al negocio `intrale`.
- [ ] Se describe cómo validar que el marcador publicado y los drafts se insertaron correctamente.

## Notas técnicas
- Recomendar uso de `Decimal` en boto3 para valores numéricos y asegurar padding de versiones (`THEME#00000001`).
- Para la bandera `--reset`, sugerir uso de `TransactWriteItems` o, en su defecto, borrar ítems individuales con `ConditionExpression` para evitar race conditions.
- Considerar compatibilidad con AWS CLI (`aws dynamodb batch-write-item --request-items file://...`) como alternativa si no se usa Python.
- Mantener ejemplos libres de credenciales; recordar exportar `AWS_PROFILE`/`AWS_ACCESS_KEY_ID` cuando aplique.
