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

### Manejo del cliente Cognito

El cliente `CognitoIdentityProviderClient` se mantiene vivo entre
invocaciones para evitar errores `ProviderClosedException` cuando la
función se ejecuta varias veces de forma consecutiva.

## Relacionado con #11
