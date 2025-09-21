# Cambio de contraseña
> Pertenece al módulo `users` dentro de la arquitectura multimódulo del proyecto.

Permite a un usuario autenticado modificar su contraseña en Cognito.

## Endpoint dinámico
`POST /{business}/changePassword`

- `business` debe corresponder a un identificador habilitado por `Config.businesses()` (por ejemplo, `intrale`).
- La app Compose construye la URL final combinando `BuildKonfig.BASE_URL` y el valor de `business` (ejemplo: `https://.../dev/intrale/changePassword`).

## Encabezados requeridos
- `Authorization`: token de acceso emitido por Cognito. Es validado por `SecuredFunction` antes de ejecutar la lógica de negocio.

## Cuerpo de la solicitud
```json
{
  "oldPassword": "MiClaveActual1",
  "newPassword": "MiClaveNueva2"
}
```

Ambos campos son obligatorios; de lo contrario el servicio responde con `400 Bad Request`.

## Respuestas
- **200 OK**: `{"statusCode":{"value":200,"description":"OK"}}`. La contraseña se actualizó correctamente.
- **400 Bad Request**: validaciones fallidas o cuerpo vacío (`RequestValidationException`).
- **401 Unauthorized**: token inexistente o rechazado por Cognito (`UnauthorizedException`).
- **500 Internal Server Error**: error inesperado devuelto como `ExceptionResponse`.

## Notas técnicas
`ChangePassword` llama a `CognitoIdentityProviderClient.changePassword`, reutilizando la instancia inyectada por Kodein. Se evita el uso de `use {}` para mantener abierto el cliente compartido y se registran los errores mediante `Logger.error`.
