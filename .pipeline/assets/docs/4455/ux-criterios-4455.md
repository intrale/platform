# Criterios UX — cuota real por proveedor (#4455)

## Jerarquía

- La matriz por proveedor es la única representación de cuota en el home.
- Se eliminan las tarjetas agregadas “Cuota sesión 5h” y “Cuota semanal”.
- Orden canónico: Anthropic, Codex/OpenAI, Gemini, Cerebras y NVIDIA NIM.
- Cada fila muestra proveedor, ventana real, estado o porcentaje y frescura.

## Semántica

- El porcentaje visible siempre se rotula como **disponibilidad**.
- Texto, barra, color, tooltip y `aria-label` derivan de la misma magnitud normalizada.
- Dato ausente, inválido o vencido: `sin dato`; nunca `0%` o `100%` por defecto.
- Límite categórico sin porcentaje fidedigno: `TOPE ACTIVO`, con tiempo de reintento si existe.
- No se agregan ni comparan porcentajes entre proveedores o ventanas diferentes.

## Sistema visual

- Superficie: `#141B2D`; fondo: `#0B1020`; borde: `#2A354D`.
- Texto primario: `#F8FAFC`; secundario: `#94A3B8`.
- Disponible ≥50%: `#37D39A`; 20–49%: `#F5B942`; <20% o tope: `#F0616C`.
- Sin dato: `#64748B`, barra punteada y texto explícito.
- El color nunca es el único indicador de estado.

## Responsive y accesibilidad

- Desktop: cuatro columnas; mobile: proveedor arriba y ventana/estado apilados debajo.
- Sin scroll horizontal a 320 px.
- Touch targets mínimos de 44×44 px y contraste WCAG AA.
- `aria-label`: “<proveedor>, <ventana>, <N>% disponible, actualizado <tiempo>”.
- Para `sin dato`, explicar la causa en tooltip o descripción accesible.

## Asset final

- `.pipeline/assets/mockups/4455/provider-quota-matrix.svg`
