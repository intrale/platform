# Bandera `DASHBOARD_ANIMATIONS_ENABLED`

Relacionado con #290.

## Contexto

Se detectó un crash al navegar hacia `/dashboard` luego del login. La causa principal se
relacionó con excepciones propagadas durante composiciones animadas del menú semicircular
y el uso inseguro de `safeString`. Como medida de contingencia se incorporó la bandera
`DASHBOARD_ANIMATIONS_ENABLED` en `ui/sc/business/DashboardScreen.kt` para desactivar
transiciones y mantener la experiencia estable.

## Valor actual

- `DASHBOARD_ANIMATIONS_ENABLED = false`

Con este valor la pantalla utiliza el layout estático (`LegacyDashboardLayout`) y evita
invocar el componente `SemiCircularHamburgerMenu` que depende de animaciones complejas.

## Cómo reactivar las animaciones

1. Cambiar el valor de la constante a `true`.
2. Verificar manualmente el flujo **Login → Dashboard** durante varias iteraciones.
3. Revisar logs para asegurarse de que no aparezcan excepciones relacionadas con
   `safeString` o `ComposeRuntimeError`.
4. Confirmar que el menú semicircular funciona correctamente antes de liberar el cambio.

> ⚠️ Mantener esta bandera en `false` hasta completar una solución definitiva para las
> animaciones del Dashboard.
