# Solicitar unión a un negocio
> Pertenece al módulo `users`.

Permite que un Delivery pida incorporarse a un negocio existente.

```
POST /{business}/requestJoinBusiness
```

Se requiere un token JWT válido del Delivery. Al recibir la petición se guarda un registro en `UserBusinessProfile` con estado `PENDING`.

Desde la versión actual el cliente `CognitoIdentityProviderClient` se mantiene abierto para evitar fallos por cierre inesperado.

### Pantallas de la aplicación
- `RequestJoinBusinessScreen` permite al delivery enviar la solicitud indicando el negocio.
- `ReviewJoinBusinessScreen` habilita al administrador del negocio aprobar o rechazar las solicitudes recibidas.
