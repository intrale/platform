Historia con impacto visual acotado sobre la pestana Productos
(`views/dashboard/estado-productos.js`): dos acciones nuevas, Editar y
Desactivar, mas un estado nuevo `archived` dentro del design system V3 existente.

Assets versionados para #4806:
- `.pipeline/assets/icons/sprite.svg`: contiene `#ic-edit` y `#ic-archive-box`.
- `.pipeline/assets/mockups/45-product-edit-deactivate.svg`: mockup
  self-contained con card activa, card archivada y confirmacion destructiva.

Guideline visual:
- Editar usa `#ic-edit`, estilo secundario neutro y rotulo textual.
- Desactivar usa `#ic-archive-box`, outline danger y rotulo textual.
- `archived` se muestra como "Archivado", conserva el descriptor y deshabilita
  acciones mutantes.
- La baja es soft-delete (`status: archived`), nunca borrado fisico.
- La confirmacion advierte que las olas en curso terminan con agentes ya
  despachados, pero el producto no recibe nuevos slots.

Verificaciones esperadas:
- `Test-Path .pipeline/assets/mockups/45-product-edit-deactivate.svg` -> `True`.
- `Test-Path .pipeline/assets/mockups/4806` -> `True`.
- `Select-String .pipeline/assets/mockups/45-product-edit-deactivate.svg -Pattern 'Editar|Desactivar|Archivado'` devuelve matches.
- No debe haber mojibake visible en textos de la evidencia.
