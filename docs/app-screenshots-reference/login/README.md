# Pantalla: `login`

## Alcance del flujo

Autenticación del usuario con email + password. Cubre también el sub-flow de
recuperación de contraseña (`recovery`) y la confirmación de recovery, que
viven en el mismo módulo de UI y comparten composables (`ui/sc/login/`).

Pantallas equivalentes en otros flavors: la lógica de autenticación es
compartida entre `client`, `business` y `delivery`, pero el header de
branding (logo, color del CTA principal) puede cambiar por flavor — los PNGs
canónicos deben capturarse por cada flavor que tenga branding propio.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                            |
|------------|---------|------------------------------------------------------------------|
| `default`  | Sí      | Form vacío al abrir.                                             |
| `empty`    | No      | Coincide con `default` (no es una colección).                    |
| `loading`  | Sí      | Spinner durante el `POST /signin`.                               |
| `error`    | Sí      | Mensaje de credenciales inválidas o validación de campos.        |
| `success`  | No      | El "éxito" es la navegación a `home`, no un estado de `login`.   |

Sub-flow `recovery` (mismo módulo):

- `login-<flavor>-recovery-empty-<fecha>.png` — pantalla de recovery vacía.
- `login-<flavor>-recovery-filled-<fecha>.png` — con email cargado, listo para submit.
- `login-<flavor>-recovery-submitted-<fecha>.png` — confirmación tras envío.

## Diferenciación por flavor

- `client`: header con marca Intrale, CTA "Ingresar" en color de marca client.
- `business`: header "Intrale Negocios", paleta de marca business.
- `delivery`: header "Intrale Repartos", paleta de marca delivery.

El layout del form (campos email/password, links secundarios) es
**compartido** entre flavors — no replicar capturas por flavor si solo
cambian las propiedades de branding del header.

## Accesibilidad esperada

- Contraste de texto del CTA principal: mínimo WCAG AA (4.5:1).
- Labels permanentes sobre los inputs (no solo placeholders que desaparecen
  al escribir).
- Touch targets mínimos 48dp en CTA principal y links de recovery/signup.
- Mensajes de error con icono + texto (no solo color rojo).

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/login/`.
- Issues relacionados: [#1090](https://github.com/intrale/platform/issues/1090), [#1091](https://github.com/intrale/platform/issues/1091), [#1112](https://github.com/intrale/platform/issues/1112), [#1915](https://github.com/intrale/platform/issues/1915), [#2062](https://github.com/intrale/platform/issues/2062).
