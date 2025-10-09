# 🛡️ Guardas de Refinamiento

Objetivo
- Evitar efectos colaterales en el repo durante "refinar".

Guardas
- Antes de finalizar, verificar que **no hubo** cambios en el árbol del repo.
- Si se detecta intención/acción de crear o editar archivos → **cancelar**,
  marcar la issue como **Blocked** y reportar: "Refinamiento solo en CUERPO".
- **No** publicar comentarios con el contenido del refinamiento.
