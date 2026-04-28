# Mockups UX — #2820 (split de #2748)

#2820 entrega **únicamente la pantalla "Equipo" + CRUD de empleados** del flavor
`business`. El flujo de aceptación por deep link queda fuera de scope (lo entrega
la historia hermana c.2.b — #2821).

## Mockups en scope (referencia desde `.pipeline/assets/mockups/2748/`)

Los siguientes mockups producidos para el padre #2748 aplican 1:1 a este split y
**no se duplican acá** para evitar deriva entre fuentes:

| Mockup | Path | Cubre criterio (issue #2820) |
|---|---|---|
| Lista completa de equipo | `.pipeline/assets/mockups/2748/01-team-list-full.svg` | E2 (listado), E5 (menú contextual), E7 (último OWNER sin opciones) |
| Estado vacío con Murble | `.pipeline/assets/mockups/2748/02-team-empty-murble.svg` | E3 (empty state + CTA inline al BottomSheet) |
| BottomSheet de invitación | `.pipeline/assets/mockups/2748/03-invite-bottomsheet.svg` | E4 (campo email + 4 chips de rol + CTA validado) |
| Dialog destructivo de revocación | `.pipeline/assets/mockups/2748/06-revoke-confirmation-dialog.svg` | E6 (confirmación M3 destructiva) |
| Sistema de chips de rol | `.pipeline/assets/mockups/2748/07-role-chips-system.svg` | E2 chip M3 + paleta WCAG AA + tokens |

## Mockups fuera de scope (NO usar en #2820)

Pertenecen a la historia hermana #2821 (c.2.b — flujo deep link de aceptación) y
**no se renderizan ni navegan** en #2820:

- `04-invitation-accept.svg` — pantalla de aceptación con deep link.
- `05-invitation-error-states.svg` — errores de deep link (expirado, reutilizado,
  email distinto).

## Drawables entregados (paths finales del repo)

Todos en `app/composeApp/src/commonMain/composeResources/drawable/` (commit
`7387e424` mergeado a `feature/dashboard-v3-kanban-protagonist-2800`):

- `ic_team_role_owner.xml` — corona (chip rol OWNER, container=primaryContainer).
- `ic_team_role_manager.xml` — escudo+check (chip rol MANAGER, container=tertiaryContainer).
- `ic_team_role_cashier.xml` — caja registradora (chip rol CASHIER, container=secondaryContainer).
- `ic_team_role_employee.xml` — persona (chip rol EMPLOYEE, container=surfaceContainerHigh).
- `ic_team_menu.xml` — entrada "Equipo" del home (24dp).
- `ic_team_status_pending.xml` — reloj (badge estado PENDIENTE).
- `team_murble_friendly.xml` — companion blob 200dp (estado EMPTY, tinte=tertiary).

> `ic_invitation_envelope.xml` también está commiteado pero su uso pertenece a
> #2821 (hero icon de InvitationScreen), no a #2820.

## Decisiones bloqueantes (heredadas del padre #2748)

1. **Visibilidad — no deshabilitado**: las opciones del menú contextual `⋮` que
   un rol no puede ejecutar **no se renderizan**. No aparecen en gris.
2. **Email enmascarado**: snackbar de éxito + dialog destructivo + mensajes de
   error muestran `j***@***.com`. El email completo solo aparece en el ítem
   propio del listado.
3. **Token nunca en pantalla ni en logs**: el cliente no debe loguear ni mostrar
   el token de invitación que devuelva el backend.
4. **Bloqueo del último OWNER**: la opción "Revocar" no se renderiza en el menú
   del único OWNER. El backend (#2440) es autoritativo y rechaza con código de
   error mapeable a copy.
5. **Foco inicial en "Cancelar"** del dialog destructivo (Material3 best
   practice — el foco no apunta a la acción peligrosa).
6. **CTA inline en estado vacío**: además del FAB, el empty state tiene un
   botón inline que abre el BottomSheet de invitación directamente.

## Tema y accesibilidad

- Cero colores ad-hoc — todos los chips usan tokens del tema en `ui/th/Color.kt`
  (`primaryContainer`, `secondaryContainer`, `tertiaryContainer`,
  `surfaceContainerHigh`).
- Contraste verificado ≥ 12:1 (AAA, supera AA por amplio margen).
- Touch targets ≥ 48dp en FAB, menú contextual, chips, CTA del dialog.
- `contentDescription` obligatorio en avatar, FAB, menú `⋮`, dialog destructivo.
- Estados (PENDIENTE / ACTIVO / REVOCADO) **no dependen solo del color** — siempre
  combinan icono + chip + texto.
