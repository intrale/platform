# ✅ Nombres de Status (Project V2)

Estados (usar EXACTAMENTE estos nombres):
- Backlog CLIENTE: historias nuevas para las features del cliente (usuario/auto) sin detalle.
- Backlog NEGOCIO: historias nuevas para las features del negocio (usuario/auto) sin detalle.
- Backlog DELIVERY: historias nuevas para las features del delivery (usuario/auto) sin detalle.
- Refined: historias detalladas (funcional + técnico) listas para priorizar.
- Todo: priorizadas para empezar; DEBEN venir de Refined.
- In Progress: en desarrollo activo (tomadas desde Todo).
- Ready: desarrollo completo (PR creado y asignado a `leitolarreta` con `Closes #<n>`); listo para QA/validación. **Definición canónica** — otros módulos referencian esta, no la redefinen.
- Done: verificadas; cumplen todos los criterios de aceptación.
- Blocked: impedidas en cualquier etapa; requiere causa/documento.

Reglas de validación:
- Verificar existencia del status antes de cambiarlo.
- Si no existe: listar opciones válidas y NO cambiar.
- Cuando se cambie el estado: comentar en la issue
  `Status cambiado a "<Estado>"` + link al item del Project.
- Si la issue no está en el Project: agregarla antes de cambiar.
- Al pasar a Blocked: registrar causa técnica (error/log/enlace).

> **Semántica:** estos Status son del **tablero declarativo** de GitHub Projects V2
> (`leitocodexbot`). El estado operativo real del pipeline V3 vive en el filesystem
> (carpetas `pendiente/trabajando/listo/procesado`, gestionadas por el Pulpo). No
> confundir un Status del tablero con la carpeta de estado del Pulpo.
