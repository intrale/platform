# Solicitar unión a un negocio
> Pertenece al módulo `users`.

Permite que un Delivery pida incorporarse a un negocio existente.

```
POST /{business}/requestJoinBusiness
```

Se requiere un token JWT válido del Delivery. Al recibir la petición se guarda un registro en `UserBusinessProfile` con estado `PENDING`.
