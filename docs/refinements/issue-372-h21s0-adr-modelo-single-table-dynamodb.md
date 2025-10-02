# Refinamiento – Issue #372

_Repositorio: intrale/platform_

## Objetivo
Documentar una decisión arquitectónica (ADR) que formalice el modelo single-table de DynamoDB para el servicio de branding, detallando claves, tipos de ítems, patrones de acceso y consideraciones operativas.

## Contexto
- El frontend multiplataforma ya soporta recursos de branding dinámico (`buildSrc/ar/com/intrale/branding/**` y `app/composeApp/**`), pero falta una fuente de verdad consolidada que sirva temas publicados, borradores y assets.
- Los issues H2.1.S1–H2.1.S6 dependen de una definición estable de la tabla para ejecutar runbooks, seeds y pruebas automatizadas.
- Actualmente no existe un ADR que deje asentada la convención `BUS#<businessId>` / `THEME#<version>` ni las garantías de publicación única.

## Cambios requeridos
- Crear `docs/branding/adr-modelo-datos-dynamodb.md` (o actualizarlo si ya existe) siguiendo la estructura estándar de ADR (Estado, Fecha, Contexto, Decisión, Consecuencias, Notas operativas).
- Incluir en la decisión:
  - Nombre de la tabla (`branding`) y convención de prefijo para ambientes (`branding-dev`, `branding-stg`, `branding-prd`).
  - Claves primarias `PK` (String) y `SK` (String) con `BUS#<businessId>` y `THEME#<versionPad>` / `PUBLISHED`.
  - Tipos de ítem necesarios (`THEME`, `PUBLISHED_MARKER`, `ASSET`, `ASSET_LINK`, opcional `BUSINESS`).
  - Atributos obligatorios (`status`, `version`, `metadata`, `assets`, `updatedAt`, `publishedAt`, `publishedBy`).
- Documentar patrones de acceso prioritarios:
  - Recuperar tema publicado (GetItem al marcador + GetItem de la versión).
  - Listar borradores vía `Query` con `begins_with(SK, "THEME#")` + filtro `status = draft`.
  - Obtener assets individuales por `ASSET#<assetId>`.
- Describir las operaciones críticas de publicación/rollback usando `ConditionExpression` para asegurar unicidad del marcador.
- Añadir ejemplos JSON de ítems reales (marker publicado, theme draft/published, asset) para guiar futuras seeds/tests.
- Registrar consecuencias operativas (PITR, TTL opcional, costos on-demand) y riesgos (padding de versión, consistencia fuerte, necesidad de GSIs futuros).
- Referenciar los issues dependientes (#373, #374, #375, #376, #377, #378) como consumidores del ADR.

## Criterios de aceptación
- [ ] El ADR está versionado en `docs/branding/adr-modelo-datos-dynamodb.md` con todos los apartados descritos.
- [ ] Se documentan al menos tres patrones de acceso con ejemplos concretos.
- [ ] Se incluyen fragmentos de `ConditionExpression` para publish/rollback que puedan reutilizarse en la implementación del repositorio.
- [ ] Se listan consecuencias y riesgos que permitan trazar decisiones futuras (por ejemplo, cuándo crear un GSI).

## Notas técnicas
- Mantener el lenguaje en Español Latinoamericano y enlazar con documentación existente (`docs/branding-build-android.md`, `docs/branding-build-ios.md`) para mostrar impacto en clientes.
- Utilizar tablas Markdown para resumir tipos de ítem y atributos.
- Citar referencias de AWS DynamoDB (links oficiales) sólo si aportan contexto adicional y están disponibles públicamente.
- Validar que el ADR siga el formato empleado en otros documentos (`docs/branding/manifest-placeholders.md` etc.) para consistencia editorial.
