# Pipeline V2 — Pendientes de implementacion

> Ultima actualizacion: 2026-03-28

## A2 — Seedear issues con labels en GitHub

**Que falta:** No hay issues en GitHub con labels `needs-definition` ni `ready`. El intake del Pulpo funciona pero no tiene materia prima.

**Que hacer:**
1. Crear 2-3 issues de prueba con label `needs-definition` para probar pipeline de definicion
2. Crear 2-3 issues con label `ready` + label de area (`area:backend`, `app:client`, etc.) para probar pipeline de desarrollo
3. Verificar que el Pulpo los toma en el siguiente ciclo de intake (5 min)

**Prerequisito:** Decidir que issues usar (pueden ser issues reales del backlog o issues de prueba descartables)

**Esfuerzo:** Simple (15 min)

---

## C2 — Division de historias en planner (sizing "grande")

**Que falta:** Cuando el planner dimensiona una historia como "grande", deberia dividirla en 2-3 sub-issues. Esto no esta implementado.

**Diseno (de `docs/pipeline-v2-diseno.md` lineas 85-112):**
1. Planner evalua historia → resultado: "grande, dividir"
2. Crear 2-3 issues hijos en GitHub referenciando la madre (`gh issue create`)
3. Issues hijos entran al pipeline de definicion en fase `criterios` (no `analisis`)
4. Historia madre se marca como "dividida" y sale del pipeline
5. Si PO/UX rechazan una parte dividida → vuelve a sizing (ciclo criterios ↔ sizing)
6. Limite: 2 reintentos del ciclo, despues escala al usuario

**Que implementar:**
- En `roles/planner.md`: instrucciones para detectar "grande" y generar division
- En `brazoBarrido`: logica especial para fase `sizing` con resultado "dividir"
  - Crear issues en GitHub via cola `servicios/github/pendiente/`
  - Crear archivos en `definicion/criterios/pendiente/` para cada sub-issue
  - Marcar issue madre como "dividida" en el archivo de resultado
- En `config.yaml`: agregar `fase_rechazo` condicional para definicion (criterios → sizing solo para historias divididas)

**Riesgo:** Es la pieza mas compleja del pipeline de definicion. El planner es el unico agente que puede crear trabajo en una fase anterior (criterios esta antes de sizing).

**Esfuerzo:** Grande (requiere cambios en planner.md + pulpo.js + config.yaml + testing)

---

## C3 — Tracking real de tokens (/costos)

**Que falta:** El handler `/costos` lee logs y muestra estadisticas basicas (cantidad de ejecuciones, KB de output por skill). No hay tracking real de tokens consumidos.

**Problema tecnico:** `claude -p` con `--output-format text` no reporta consumo de tokens en su output. Opciones:

1. **Usar `--output-format json`** y parsear el campo de usage del JSON de respuesta
   - Pro: datos reales de tokens
   - Contra: requiere cambiar el parsing de respuesta en brazoCommander y lanzarAgenteClaude
2. **Estimar por tamano de output** (heuristica: ~4 chars = 1 token)
   - Pro: no requiere cambios en el flujo
   - Contra: es una estimacion, no datos reales
3. **Usar la API de Anthropic directamente** en vez de CLI
   - Pro: control total del usage
   - Contra: rewrite significativo

**Recomendacion:** Opcion 1 — cambiar a `--output-format json` en el commander y parsear `usage.input_tokens` + `usage.output_tokens`. Guardar en `commander-costs.jsonl` con formato:
```json
{"timestamp":"...","skill":"commander","issue":"telegram","input_tokens":1234,"output_tokens":567}
```

**Esfuerzo:** Medio

---

## C4 — Servicio Drive (Google Drive)

**Que falta:** `servicio-drive.js` es un stub completo. Todas las operaciones logean `[STUB]` y no hacen nada.

**Para que se necesita:**
- QA sube videos de evidencia E2E
- Delivery sube reportes de release
- Cualquier agente puede dejar un pedido en `servicios/drive/pendiente/`

**Que implementar:**
1. Obtener credentials de Google (Service Account o OAuth)
2. Implementar upload de archivos via Google Drive API v3
3. Implementar creacion de carpetas
4. Retornar URL publica del archivo subido
5. Guardar URL en el archivo de resultado del agente

**Formato del pedido:**
```json
{
  "action": "upload",
  "file": "/path/to/video.mp4",
  "folder": "QA-Evidence/issue-1732",
  "share": true
}
```

**Prerequisitos:**
- Cuenta de Google con Drive API habilitada
- Service Account JSON o OAuth client credentials
- Carpeta raiz compartida para el proyecto

**Esfuerzo:** Medio (API conocida, pero setup de credentials y permisos)

---

## Mejoras menores detectadas (no criticas)

### sendTelegram parse_mode
El handler `/status` usa Markdown con `*bold*` pero el servicio telegram envia con `parse_mode: Markdown` que es legacy. Considerar migrar a `MarkdownV2` o `HTML` para evitar problemas de escape.

### Logs cleanup
No hay rotacion de logs en `.pipeline/logs/`. Con el tiempo se acumulan archivos `{issue}-{skill}.log` y `build-{issue}.log`. Considerar agregar limpieza periodica (ej: borrar logs > 7 dias).

### Dashboard: drill-down por issue
El dashboard muestra conteos pero no permite ver el detalle de un issue especifico. Seria util poder hacer click en un issue y ver su recorrido completo por fases.

### Agente multi-tarea
El diseno original dice "Procesa todo lo pendiente de su skill (no solo una tarea)". La implementacion actual lanza un agente por tarea. Esto esta bien para la concurrencia configurada, pero si un skill tiene 5 tareas pendientes y concurrencia 1, se lanzan secuencialmente (una muere, se lanza la siguiente). Evaluar si vale la pena que un agente procese multiples tareas en un solo ciclo de vida.
