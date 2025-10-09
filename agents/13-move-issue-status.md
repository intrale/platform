# 🔀 Mover estado de Issue (Project V2)

Objetivo
- Cambiar el campo **Status** de una issue en el Project V2 “Intrale”.

Precondiciones
- Repo y issue existen.
- Issue está (o puede agregarse) al Project V2.
- Campo single-select se llama **Status**.

Secuencia (obligatoria)
1) Resolver `projectId`, `statusFieldId`, `statusOptionId` por nombre del
   status objetivo.
2) Si la issue **no** está en el Project: **agregarla**.
3) Actualizar **Status** del item a la opción solicitada.
4) Comentar en la issue: `Status cambiado a "<Status>"` + link al Project item.

Reglas
- Los nombres de Status deben coincidir **exactamente** (ej.: `Todo`,
  `In Progress`, `Backlog`).
- Si el Status no existe: **no inventar**; listar opciones válidas y
  marcar la issue como **Blocked** con explicación.

Criterios de aceptación
- El item del Project refleja `Status = <objetivo>`.
- Hay comentario en la issue con el cambio y enlaces.

Errores y fallback
- Falla de permisos/API: mover a **Blocked** y detallar causa.
- Si el Project no existe: terminar en **Blocked** con diagnóstico.