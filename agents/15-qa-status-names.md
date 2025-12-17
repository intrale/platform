# ✅ Nombres de Status (Project V2)

Estados (usar EXACTAMENTE estos nombres):
- Backlog CLIENTE: historias nuevas para las features del cliente (usuario/auto) sin detalle.
- Backlog NEGOCIO: historias nuevas para las features del negocio (usuario/auto) sin detalle.
- Backlog DELIVERY: historias nuevas para las features del delivery (usuario/auto) sin detalle.
- Refined: historias detalladas (funcional + técnico) listas para priorizar.
- Todo: priorizadas para empezar; DEBEN venir de Refined.
- In Progress: en desarrollo activo (tomadas desde Todo).
- Ready: desarrollo completo; listas para prueba/validación.
- Done: verificadas; cumplen todos los criterios de aceptación.
- Blocked: impedidas en cualquier etapa; requiere causa/documento.

Reglas de validación:
- Verificar existencia del status antes de cambiarlo.
- Si no existe: listar opciones válidas y NO cambiar.
- Cuando se cambie el estado: comentar en la issue
  `Status cambiado a "<Estado>"` + link al item del Project.
- Si la issue no está en el Project: agregarla antes de cambiar.
- Al pasar a Blocked: registrar causa técnica (error/log/enlace).
