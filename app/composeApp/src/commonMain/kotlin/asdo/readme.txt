La capa `asdo` contiene los casos de uso del dominio.

- `auth/` incluye procesos de autenticación (inicio de sesión, recuperación de contraseña, 2FA y caché de sesión).
- `signup/` agrupa los flujos de registro de usuarios, vendedores y resultados asociados.
- `business/` concentra los casos de uso para gestionar negocios (registro, revisiones, búsquedas y solicitudes de unión).
- `shared/` está disponible para reutilizar contratos o estructuras comunes si hiciera falta.

Cada paquete mantiene la separación entre interfaces `ToDo` y sus implementaciones `Do` para facilitar las pruebas y la inyección de dependencias.
