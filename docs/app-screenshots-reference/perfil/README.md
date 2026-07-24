# Pantalla: `perfil`

## Alcance del flujo

Perfil del usuario logueado: datos personales (nombre, email, teléfono),
ajustes (notificaciones, tema, idioma), accesos secundarios (mis pedidos,
mis direcciones, cerrar sesión).

Aplica a los tres flavors con variaciones en los campos visibles.

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/perfil/` (o equivalente).

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `default`  | Sí      | Perfil con datos sintéticos cargados.                                   |
| `empty`    | No      | Coincide con `default` (siempre tiene al menos email/nombre).           |
| `loading`  | Sí      | Mientras carga datos del usuario (rare path post-cold-start).           |
| `error`    | Sí      | Token expirado / network al cargar.                                     |
| `success`  | Sí      | Confirmación tras "Guardar cambios" del perfil editable.                |

## Diferenciación por flavor

- `client`: nombre, email, teléfono, direcciones guardadas, método de pago default.
- `business`: nombre del comercio, CUIT, datos fiscales, horarios, configuración de catálogo.
- `delivery`: nombre, documento, vehículo, zona de cobertura.

Cada flavor tiene su propio PNG canónico porque la estructura del perfil
diverge significativamente.

## Datos sintéticos obligatorios

- Nombre: "Usuario QA" (o equivalente sintético).
- Email: `qa@intrale.test`.
- Teléfono: `+54 9 11 0000 0000`.
- CUIT (business): `30-00000000-0` (formato válido sintético).
- Documento (delivery): `00.000.000` (sintético).

## Accesibilidad esperada

- Campos editables con label permanente + estado visual claro
  (lectura vs edición).
- Botón "Cerrar sesión" con confirmación previa (no acción accidental).
- Cambios pendientes con indicador visible antes de salir de la pantalla.

## Referencias

- Issues relacionados: [#1093](https://github.com/intrale/platform/issues/1093) (profile-selector), [#1092](https://github.com/intrale/platform/issues/1092).
