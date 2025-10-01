# ADR: Modelo de datos single-table en DynamoDB para branding

## Estado
Aprobado

## Fecha
2025-09-28

## Contexto
El módulo de branding debe exponer los temas visuales que cada negocio tiene en Intrale. El diseño relacional previo implicaba múltiples consultas y joins para recuperar un tema publicado, sus borradores y los assets asociados. Buscamos reducir latencia y costo operativo concentrando la información en una sola tabla de DynamoDB, con acceso optimizado para:

- Obtener el tema publicado por `businessId`.
- Listar borradores vigentes.
- Recuperar versiones específicas para previsualización.
- Consultar metadatos de assets (logos, banners, íconos).

## Decisión
Se define una tabla única denominada `branding` con claves primarias `PK` y `SK` (ambas `String`). La tabla almacenará todos los ítems relevantes con un atributo `type` que describe su naturaleza. Se adopta la convención de agrupar por negocio usando `PK = BUS#<businessId>` y de serializar la versión numérica del tema con `zero padding` (por ejemplo `00000042`) para mantener el orden lexicográfico.

Los borradores y versiones publicadas se representarán con ítems `THEME` diferenciados por el atributo `status` (`draft` o `published`). Se mantiene un marcador exclusivo `PUBLISHED_MARKER` que asegura la unicidad del tema publicado por negocio.

Los assets se modelan como ítems con `PK = ASSET#<assetId>` para permitir acceso directo por identificador global. Opcionalmente se podrá duplicar la relación bajo la clave del negocio cuando se necesite agruparlos por `businessId`.

## Tipos de ítem y claves
| type | PK | SK | Atributos relevantes |
|------|----|----|-----------------------|
| `BUSINESS` (opcional) | `BUS#<businessId>` | `META` | Datos descriptivos del negocio (nombre, timestamps). |
| `THEME` | `BUS#<businessId>` | `THEME#<version>` | `version` (`Number`), `status` (`draft`/`published`), `metadata` (colores, fuentes, etc.), `assets` (refs a assetId), `updatedAt`. |
| `PUBLISHED_MARKER` | `BUS#<businessId>` | `PUBLISHED` | `version` (`Number`), `publishedAt`, `publishedBy`. |
| `ASSET` | `ASSET#<assetId>` | `META` | `businessId`, `type` (logo/banner/icon), `uri` (S3 u origen), `checksum`, `updatedAt`. |
| `ASSET_LINK` (opcional) | `BUS#<businessId>` | `ASSET#<assetId>` | Referencia cruzada para listados por negocio, atributo `scope` (ej. `theme`). |

## Patrones de acceso
- **Tema publicado**: `GetItem` → `PK = BUS#<businessId>`, `SK = PUBLISHED` para recuperar la versión actual y luego `GetItem` del `THEME` correspondiente (`SK = THEME#<version>`).
- **Listar borradores**: `Query` → `PK = BUS#<businessId>`, `begins_with(SK, "THEME#")` con filtro `status = "draft"`. Se considera un GSI futuro (`status-index`) sólo si el volumen de filtros impacta en consumo; por ahora no se crea índice secundario.
- **Obtener versión específica**: `GetItem` → `PK = BUS#<businessId>`, `SK = THEME#<version>`.
- **Metadatos de asset**: `GetItem` → `PK = ASSET#<assetId>`, `SK = META`. Si se requiere listarlos por negocio se puede `Query` sobre `PK = BUS#<businessId>` con prefijo `ASSET#`.

## Integridad y operaciones de publish
Para garantizar una única versión publicada por negocio se aplican las siguientes condiciones:

### Publicación inicial
```json
{
  "Operation": "PutItem",
  "Key": {"PK": {"S": "BUS#123"}, "SK": {"S": "PUBLISHED"}},
  "Item": {"type": {"S": "PUBLISHED_MARKER"}, "version": {"N": "42"}},
  "ConditionExpression": "attribute_not_exists(PK)"
}
```

### Cambio de versión publicada (publish / rollback)
```json
{
  "Operation": "UpdateItem",
  "Key": {"PK": {"S": "BUS#123"}, "SK": {"S": "PUBLISHED"}},
  "UpdateExpression": "SET #v = :next, #updatedAt = :now",
  "ConditionExpression": "#v = :expected",
  "ExpressionAttributeNames": {"#v": "version", "#updatedAt": "updatedAt"},
  "ExpressionAttributeValues": {":expected": {"N": "42"}, ":next": {"N": "43"}, ":now": {"S": "2025-09-28T14:31:00Z"}
  }
}
```
Esto permite publicar una nueva versión (`:next`) o hacer rollback siempre que la versión actual coincida con `:expected`.

La creación o actualización del ítem `THEME` también se ejecuta con `ConditionExpression` para evitar sobreescribir versiones existentes (`attribute_not_exists(PK)` en `PutItem` o `version = :expected` en `UpdateItem`).

## Ejemplos de ítems
```json
{
  "PK": {"S": "BUS#123"},
  "SK": {"S": "THEME#00000042"},
  "type": {"S": "THEME"},
  "version": {"N": "42"},
  "status": {"S": "draft"},
  "metadata": {"M": {
    "primaryColor": {"S": "#0F172A"},
    "secondaryColor": {"S": "#22D3EE"},
    "typography": {"S": "intrale-regular"}
  }},
  "assets": {"L": [
    {"S": "ASSET#logo-123"},
    {"S": "ASSET#banner-123"}
  ]},
  "updatedAt": {"S": "2025-09-21T10:00:00Z"}
}
```

```json
{
  "PK": {"S": "BUS#123"},
  "SK": {"S": "PUBLISHED"},
  "type": {"S": "PUBLISHED_MARKER"},
  "version": {"N": "41"},
  "publishedAt": {"S": "2025-09-10T08:30:00Z"},
  "publishedBy": {"S": "user-789"}
}
```

```json
{
  "PK": {"S": "ASSET#logo-123"},
  "SK": {"S": "META"},
  "type": {"S": "ASSET"},
  "businessId": {"S": "123"},
  "assetType": {"S": "logo"},
  "uri": {"S": "s3://intrale-branding/assets/logo-123.png"},
  "checksum": {"S": "md5:abcdef"},
  "updatedAt": {"S": "2025-09-18T12:45:00Z"}
}
```

## Consecuencias
- Simplifica lecturas críticas (tema publicado y previews) a `GetItem` o `Query` de baja latencia.
- Requiere disciplina en la serialización de versiones (`zero padding`) para mantener el orden lexicográfico.
- El marcador de publicación agrega una operación adicional de lectura, pero garantiza consistencia fuerte sin scans.
- Permite ampliar el modelo con GSIs específicos si nuevas necesidades de acceso lo exigen, sin romper la convención de claves existente.

## Notas operativas
- Capacidad en modo **on-demand** para absorber picos de publicación ocasionales.
- Cifrado con KMS administrado por AWS (valor por defecto en DynamoDB).
- Recomendación de habilitar **Point-in-Time Recovery (PITR)** para facilitar rollbacks masivos.
- Mantener `ttl` opcional (`timeToArchive`) en borradores obsoletos para limpieza automática.
