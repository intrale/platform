# ⌨️ Comando `/move` (Project V2)

Propósito
- Cambiar el **Status** de una issue en el Project V2.

Sintaxis (una línea)
/move repo=<owner>/<repo> issue=<n> project_owner_type=<User|Organization> project_owner_login=<login> project_number=<n> status="<NombreExacto>"

Ejemplo
/move repo=intrale/platform issue=417 project_owner_type=User project_owner_login=intrale project_number=1 status="Todo"

Comportamiento
- Si la issue no está en el Project, agregarla.
- Establecer **Status** a la opción indicada.
- Responder con links (issue + project item) y estado final.

Validaciones
- `repo`, `issue`, `project_*`, `status` son obligatorios.
- Si `status` no existe: listar opciones válidas y no cambiar nada.

Trazabilidad
- Comentar en la issue el cambio o el motivo de bloqueo.
