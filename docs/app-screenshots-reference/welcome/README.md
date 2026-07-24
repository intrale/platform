# Pantalla: `welcome`

## Alcance del flujo

Primera pantalla que ve el usuario al abrir la app (post-install, post-logout
o pre-login). Cubre el onboarding mínimo + los CTAs principales para
"Ingresar" y "Registrarme".

Es la pantalla más estable visualmente del producto — cambia poco entre
versiones y entre flavors (salvo branding del header).

Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/welcome/`.

## Estados representativos esperados

| Estado     | Aplica  | Notas                                                                   |
|------------|---------|-------------------------------------------------------------------------|
| `default`  | Sí      | Pantalla principal con logo + CTAs.                                     |
| `empty`    | No      | No aplica (no es una colección).                                        |
| `loading`  | No      | No aplica (sin fetch al abrir).                                          |
| `error`    | No      | No aplica salvo error de configuración (raro, registrar como bug).      |
| `success`  | No      | El "éxito" es la navegación a `login` o `signup`.                       |

## Diferenciación por flavor

- `client`: branding "Intrale", subtítulo orientado al consumidor.
- `business`: branding "Intrale Negocios", subtítulo orientado al comercio.
- `delivery`: branding "Intrale Repartos", subtítulo orientado al repartidor.

**Aplica a los tres flavors** — capturar uno por flavor porque el branding es
distintivo.

## Accesibilidad esperada

- CTAs principales con touch target ≥ 48dp.
- Contraste de texto WCAG AA mínimo (4.5:1).
- Logo con `contentDescription` no vacío (lectura por TalkBack).
- Orden de navegación lógico: logo → subtítulo → CTA primario → CTA secundario.

## Referencias

- Módulo UI: `app/composeApp/src/commonMain/.../ui/sc/welcome/`.
- Issues relacionados: [#1090](https://github.com/intrale/platform/issues/1090), [#1091](https://github.com/intrale/platform/issues/1091), [#1092](https://github.com/intrale/platform/issues/1092), [#1915](https://github.com/intrale/platform/issues/1915), [#2062](https://github.com/intrale/platform/issues/2062), [#2333](https://github.com/intrale/platform/issues/2333), [#2334](https://github.com/intrale/platform/issues/2334).
