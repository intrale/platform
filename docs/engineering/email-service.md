# Servicio de email e invitaciones

La clave de firma de invitaciones se configura mediante `INVITATION_HMAC_KEY`.
Debe contener al menos 32 bytes aleatorios codificados en Base64.

```bash
openssl rand -base64 32
```

El valor se entrega al proceso mediante una variable de entorno y nunca se
almacena en el repositorio. El servicio falla al iniciar si la clave está
ausente, vacía, no es Base64 válido o decodifica a menos de 32 bytes.
