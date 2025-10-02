# Refinamiento – Issue #374

_Repositorio: intrale/platform_

## Objetivo
Documentar la convención de nombres de recursos y la política IAM mínima para el servicio de branding que operará sobre la tabla DynamoDB, asegurando coherencia entre ambientes y permisos restrictivos.

## Contexto
- La iniciativa H2.1 introduce infraestructura propia (tabla, seeds, pipelines) que requiere alineación con los módulos existentes (`backend`, `users`, scripts de despliegue).
- Sin una guía formal, cada ambiente podría definir nombres o políticas distintas, generando fricción en CI/CD y riesgos de seguridad.
- El backend actual usa Ktor y funciones serverless; es necesario precisar cómo mapeará variables (`BRANDING_TABLE_NAME`, `AWS_REGION`) y qué rol IAM consumirá la tabla.

## Cambios requeridos
- Crear `docs/branding/naming-iam.md` (nombre sugerido) con:
  - **Mapa de nombres por ambiente**:
    | Recurso | dev | stg | prd |
    |---------|-----|-----|-----|
    | Tabla DynamoDB | `branding-dev` | `branding-stg` | `branding-prd` |
    | Alias de rol Lambda/API | `branding-service-dev` | `branding-service-stg` | `branding-service-prd` |
    | Parámetro SSM (table name) | `/platform/branding/dev/tableName` | `/platform/branding/stg/tableName` | `/platform/branding/prd/tableName` |
  - Convención para buckets/eventuales assets si se habilitan (placeholder documentado pero marcado como opcional).
- Especificar la política IAM mínima en JSON, otorgando sólo acciones requeridas:
  - `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem` (para drafts), `dynamodb:TransactWriteItems` (publish/rollback), `dynamodb:ConditionCheckItem` si se usa en transacciones.
  - Restricción por `Resource` al ARN de la tabla correspondiente y, si aplica, a `index/*` cuando se cree el GSI opcional (#375).
- Detallar cómo se inyectará el nombre de tabla en el backend:
  - Variables de entorno consumidas por `backend` (por ejemplo `BRANDING_TABLE_NAME`, `AWS_REGION`).
  - Integración con `init.sh`/`deploy-lambda` si se requiere exportar parámetros.
- Documentar procedimiento para crear el rol (CloudFormation/Terraform manual o consola) y asociar la política, incluyendo tags (`service=branding`).
- Añadir sección de auditoría/logging: registrar en CloudWatch los accesos y habilitar AWS CloudTrail data events si compliance lo exige.
- Referenciar a #373 (creación de tabla) y #379 (integración de auth) para mantener coherencia.

## Criterios de aceptación
- [ ] Existe `docs/branding/naming-iam.md` con tabla de convenciones y rutas SSM/ARNs parametrizados.
- [ ] La política IAM propuesta limita acciones y recursos al mínimo necesario e incluye notas sobre futuros índices.
- [ ] Se documenta claramente cómo las funciones del backend leerán el nombre de la tabla (variables/env, configuración DI).
- [ ] Se incluyen pasos de creación/asociación de roles y recomendaciones de auditoría.

## Notas técnicas
- Mantener snippets IAM en JSON validado por AWS Policy Simulator cuando se implemente.
- Usar placeholders (`<account-id>`, `<env>`) en ARN para evitar exponer datos sensibles.
- Alinear el documento con convenciones existentes en `docs/branding-build-android.md` (uso de `<brandId>` como variable) para coherencia editorial.
- Considerar agregar sección FAQ (por ejemplo, cómo manejar cuentas sandbox o ambientes efímeros).
