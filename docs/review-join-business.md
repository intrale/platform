# Revisar solicitud de unión
> Pertenece al módulo `users`.

Permite que un Business Admin apruebe o rechace la solicitud de un Delivery para unirse a su negocio.

```
POST /{business}/reviewJoinBusiness
```

### Cuerpo de la solicitud
```json
{
  "email": "delivery@dominio.com",
  "decision": "APPROVED"
}
```

Requiere token JWT válido de un usuario con perfil `BUSINESS_ADMIN`.
