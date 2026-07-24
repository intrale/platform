# Pantalla: `signup`

## Alcance del flujo

Registro de un usuario nuevo en la plataforma. Cubre el formulario completo
con validaciones de campos (email, password, confirmación), aceptación de
términos, y la confirmación de cuenta posterior (si aplica al flavor).

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/signup/`.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `default`  | Sí      | Form vacío al abrir.                                                    |
| `empty`    | No      | Coincide con `default`.                                                 |
| `loading`  | Sí      | Spinner durante el `POST /signup`.                                       |
| `error`    | Sí      | Validaciones: password mismatch, email inválido, email ya registrado.   |
| `success`  | Sí      | Confirmación post-signup (pantalla intermedia antes de login).          |

Estados de validación adicionales (sugeridos):

- `signup-<flavor>-error-passwords-mismatch-<fecha>.png` — confirmación de password no coincide.
- `signup-<flavor>-error-email-invalid-<fecha>.png` — email con formato inválido.

## Diferenciación por flavor

- `client`: signup público, sin código de invitación.
- `business`: puede requerir código de comercio / CUIT durante signup.
- `delivery`: puede requerir aprobación posterior (estado "pendiente").

Cada flavor debe declarar en su PNG si el form tiene campos distintos al de
client (ej. business agrega campo CUIT, delivery agrega vehículo).

## Accesibilidad esperada

- Indicadores de fortaleza de password con texto + icono (no solo color).
- Mensajes de error inline debajo del campo, con suficiente contraste.
- Labels permanentes sobre los inputs.
- Link a términos y condiciones distinguible por contraste y subrayado.

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/signup/`.
- Issues relacionados: [#1091](https://github.com/intrale/platform/issues/1091), [#1093](https://github.com/intrale/platform/issues/1093), [#2062](https://github.com/intrale/platform/issues/2062).
