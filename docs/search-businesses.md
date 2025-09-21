# Buscar negocios
Pertenece al módulo `users`.

Permite obtener sugerencias de negocios aprobados filtrando por texto, estado y paginación.

## Endpoint dinámico
`POST /{business}/searchBusinesses`

- `business` debe ser un identificador permitido (por ejemplo, `intrale`).
- La función `searchBusinesses` se resuelve desde el contenedor Kodein de `users` y opera sobre la tabla DynamoDB `business`.

## Cuerpo de la solicitud
```json
{
  "query": "caf",
  "status": "APPROVED",
  "limit": 10,
  "lastKey": "cafeteria-centro"
}
```

Todos los campos son opcionales:
- `query`: texto a buscar dentro del nombre del negocio.
- `status`: filtra por estado (`PENDING`, `APPROVED`, `REJECTED`).
- `limit`: cantidad máxima de resultados.
- `lastKey`: cursor para continuar la paginación (el nombre devuelto previamente).

## Respuesta
```json
{
  "statusCode": { "value": 200, "description": "OK" },
  "businesses": [
    {
      "businessId": "123",
      "publicId": "cafeteria-centro",
      "name": "Cafetería Centro",
      "description": "Desayunos y brunch",
      "emailAdmin": "dueño@cafeteria.com",
      "autoAcceptDeliveries": true,
      "status": "APPROVED"
    }
  ],
  "lastKey": null
}
```

`lastKey` sólo se incluye cuando aún quedan elementos por paginar. El listado se ordena alfabéticamente por `name` y sólo devuelve negocios cuya clave pública (`publicId`) y estado estén habilitados.
