Esta capa contiene componentes reutilizables para las pantallas.

## Botones Intrale

- `IntralePrimaryButton`: versión con relleno degradado y shimmer.
- `IntraleOutlinedButton`: variante con borde degradado y fondo transparente.
- `IntraleGhostButton`: variante sin fondo ni borde, enfocada en acciones secundarias.

Características compartidas:

- Ancho relativo al contenedor del 90 % y altura fija de 54 dp.
- Soporte para icono SVG mediante `IntraleIcon` en tamaño 22 dp.
- Propiedades `enabled` y `loading` que desactivan la interacción y muestran un indicador circular cuando corresponde.
- Registro de interacción en `org.kodein.log` con el nombre del componente.
- Estado deshabilitado con opacidad reducida (~0.6) aplicado de forma consistente.

En Android se puede visualizar el aspecto y contraste de los botones en `app/composeApp/src/androidMain/kotlin/ui/cp/IntraleButtonsPreview.kt`.