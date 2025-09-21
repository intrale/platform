# Recuperación de contraseña
> Pertenece al módulo `users`.

Solicita el envío de un código de recuperación para restablecer la contraseña de un usuario en Cognito.

## Endpoint dinámico
`POST /{business}/recovery`

- `business` debe ser un identificador habilitado (p. ej. `intrale`).
- El módulo `users` expone la función con la etiqueta `recovery`, por lo que se despacha por la misma ruta dinámica de `Application.kt`.

## Cuerpo de la solicitud
```json
{
  "email": "usuario@dominio.com"
}
```

El campo `email` es obligatorio; si está vacío o ausente se devuelve `400 Bad Request`.

## Respuestas
- **200 OK**: `{"statusCode":{"value":200,"description":"OK"}}`. Cognito envió el código de recuperación al correo indicado.
- **401 Unauthorized**: credenciales inválidas o usuario bloqueado (`UnauthorizedException`).
- **404/500**: cuando Cognito u otra dependencia reportan un error se serializa como `ExceptionResponse` con el detalle en `message`.

## Notas técnicas
`PasswordRecovery` valida la entrada con Konform, construye un `ForgotPasswordRequest` usando `UsersConfig.awsCognitoClientId` y reutiliza el cliente `CognitoIdentityProviderClient` inyectado. Los mensajes se registran con `Logger` y cualquier excepción inesperada se transforma en `ExceptionResponse` para mantener el contrato JSON homogéneo.
