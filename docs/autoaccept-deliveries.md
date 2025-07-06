# Autoaceptación de Deliveries

Este endpoint permite habilitar o deshabilitar que las solicitudes de Deliveries para un negocio sean aprobadas automáticamente.

## Endpoint

`POST /{business}/configAutoAcceptDeliveries`

### Request

```json
{
  "autoAcceptDeliveries": true
}
```

### Respuesta

- **200 OK** cuando la configuración se actualiza correctamente.
- **401 Unauthorized** si el usuario no posee perfil `BUSINESS_ADMIN`.

## Relacionado con #11
