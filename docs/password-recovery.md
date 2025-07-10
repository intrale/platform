# Recuperación de contraseña
> Pertenece al módulo `users`.

Este endpoint permite solicitar el envío de un código para restablecer la contraseña de un usuario.

## Endpoint
`/v1/users/password-recovery`

### Cuerpo de la solicitud
```json
{
  "email": "usuario@dominio.com"
}
```

### Respuestas
- **200**: Se envió el código de recuperación.
- **401**: Credenciales inválidas.
- **400**: Error de validación del request.

### Notas técnicas
El cliente `CognitoIdentityProviderClient` se utiliza sin `use` para evitar que se cierre y cause `ProviderClosedException` en llamadas sucesivas. El ciclo de vida del cliente es manejado por la inyección de dependencias.

Relacionado con #84
