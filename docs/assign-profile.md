# Asignación de perfiles
> Parte del módulo `users` dentro de la arquitectura multimódulo del proyecto.

Endpoint para asignar un perfil a un usuario dentro de un negocio.

```
POST /{business}/assignProfile
```

### Cuerpo de la solicitud

```json
{
  "email": "usuario@dominio.com",
  "profile": "BUSINESS_ADMIN"
}
```

El endpoint requiere un token JWT válido de un usuario con perfil `PLATFORM_ADMIN`.
Si la asignación es exitosa, responde código HTTP 200.

### Notas técnicas
Para obtener el perfil del usuario autenticado se utiliza `CognitoIdentityProviderClient.getUser`.
Es importante **no cerrar** el cliente luego de la llamada para evitar la excepción
`ProviderClosedException` en invocaciones posteriores.

Relacionado con #80.

