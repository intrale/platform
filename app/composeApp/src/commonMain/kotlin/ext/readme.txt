La capa `ext` expone las integraciones externas de la app (clientes HTTP e interfaces de comunicación).

- `auth/` implementa y define los servicios relacionados con autenticación, contraseñas y 2FA.
- `signup/` contiene las integraciones de registro de usuarios y vendedores.
- `business/` agrupa los clientes e interfaces de los procesos de negocios (registro, búsquedas y revisiones).
- `storage/` centraliza los contratos de almacenamiento local.
- `dto/` concentra los objetos de transferencia compartidos por los distintos dominios.

Cada paquete provee sus `Comm*` (contratos) y `Client*` (implementaciones) para mantener el acoplamiento controlado entre dominios.
