# Planificación: Agentes, Hooks y Automatización Claude Code

> Creado: 2026-02-18 | Estado: en progreso

## Análisis — Brechas detectadas en la configuración actual

| Área | Qué falta | Impacto |
|------|-----------|---------|
| **Hooks** | Solo hay `Notification`. Falta `Stop` (Claude terminó) y `PostToolUse` (ej: git push → CI auto) | Alto |
| **Skills** | No hay `/pr` (commit+push+PR integrado con convenciones Intrale) ni `/ci` (monitorear CI y notificar) | Alto |
| **MEMORY.md** | Le falta contexto de arquitectura, patrones de debugging habituales | Medio |
| **MCP Servers** | No hay ninguno. Context7 provee docs de Kotlin/Compose/Ktor en tiempo real | Medio |
| **Agentes** | No hay agentes especializados. Todo corre en el contexto principal (caro en tokens) | Alto |

---

## Elenco de Agentes

Los agentes tienen nombres propios para hacer el trabajo más ameno y distinguirlos fácilmente.

### Guru — Research & Información

**Rol**: Investigación técnica, búsqueda de documentación, exploración de codebase.
**Personalidad**: Metódico, incansable, nada se le escapa. Siempre encuentra la pista.
**Modelo**: `claude-sonnet-4-6` — La investigación requiere síntesis y juicio contextual. Haiku se pierde en búsquedas complejas; Opus es overkill para buscar docs.
**Herramientas principales**: Context7 MCP (primer punto de búsqueda), WebSearch, Glob, Grep, Read, Explore agent.
**Cuándo usarlo**:
- "¿Cómo funciona X en Kotlin/Compose/Ktor?"
- "¿Hay algún patrón en el código que haga Y?"
- "Investigá las opciones para implementar Z"
- "Buscá la documentación de esta librería"

**Skill**: `/guru <pregunta>` — lanza al agente con Context7 activado

---

### Vulcano 🔥 — Implementación

**Rol**: Escribir, editar y construir código. La mano que forja.
**Personalidad**: Preciso, artesanal. Respeta los patrones del proyecto.
**Modelo**: `claude-sonnet-4-6` para features normales. Escalar a `claude-opus-4-6` solo para decisiones arquitectónicas complejas o refactors grandes.
**Herramientas principales**: Read, Edit, Write, Bash (Gradle), Glob, Grep.
**Cuándo usarlo**:
- Implementar features
- Refactors delimitados
- Bug fixes con contexto claro

---

### CI Monitor (Background)

**Rol**: Monitorear GitHub Actions después de cada push. Notifica resultado.
**Personalidad**: Siempre mirando, nunca duerme. Reporta sin que se lo pidan.
**Modelo**: No aplica — es un script bash puro. No consume tokens.
**Implementación**: Hook `PostToolUse` detecta `git push` → script background que pollea API GitHub → notificación Telegram con resultado.
**Cuándo actúa**: Automáticamente tras cada `git push`, sin intervención manual.

---

### Doc — Issues & Docs

**Rol**: Crear, refinar y documentar issues de GitHub. Redactar docs técnicas.
**Personalidad**: Elocuente, bilingüe (español/inglés en código), estructurado.
**Modelo**: `claude-sonnet-4-6` — Escribir bien requiere calidad. Haiku produce texto genérico.
**Herramientas**: GitHub API, Read, Write.
**Skills**: `/doc`, `/doc refinar`, `/doc nueva`, `/doc priorizar`

---

### Tester — Testing

**Rol**: Ejecutar tests, verificar cobertura, revisar calidad de código.
**Personalidad**: Cuestiona todo. No da el visto bueno fácil.
**Modelo**: `claude-haiku-4-5-20251001` para correr tests y parsear resultados. `claude-sonnet-4-6` si hay que analizar fallos complejos.
**Herramientas**: Bash (Gradle test/kover), Read, Grep.
**Skill**: `/tester` — corre tests + verifica coverage + reporta

---

### DeliveryManager — PR & Deploy

**Rol**: Commit + push + PR con convenciones Intrale en un solo comando.
**Personalidad**: Veloz y confiable. Siempre entrega en tiempo y forma.
**Modelo**: `claude-haiku-4-5-20251001` — Es una tarea mecánica basada en plantilla. Haiku lo hace igual de bien que Sonnet a la mitad del costo.
**Herramientas**: Bash (git), GitHub API (gh).
**Skill**: `/delivery <descripcion>` — workflow completo de entrega

---

## Hooks — Plan de implementación

### Hooks actuales (solo Notification → Telegram para todo)

```json
"Notification": [{ "matcher": "", "hooks": [...] }]
```

### Hooks a agregar

| Hook | Matcher | Script | Propósito |
|------|---------|--------|-----------|
| `Stop` | `""` | `stop-notify.sh` | Notifica por Telegram cuando Claude termina |
| `PostToolUse` | `"Bash"` | `post-git-push.sh` | Detecta git push → lanza monitoreo CI en background |

### Flujo PostToolUse + CI Monitor

```
git push (Bash tool)
    → post-git-push.sh detecta el push
        → lanza ci-monitor.sh en background (nohup)
            → pollea GitHub API cada 30s
                → notifica por Telegram con resultado ✅ / ❌
```

---

## MCP Servers

### Context7 (configurado en global settings.json)

```json
"mcpServers": {
  "context7": {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp"]
  }
}
```

**Uso esperado por Guru**:
1. Primero consultar Context7 para documentación oficial actualizada
2. Si no hay resultado, usar WebSearch
3. Último recurso: leer directamente el código fuente de librerías

---

## Roadmap de implementación

- [x] Análisis y planificación (este doc)
- [x] Hook `Stop` + `stop-notify.sh`
- [x] Hook `PostToolUse` + `post-git-push.sh` + `ci-monitor.sh`
- [x] MCP Context7 en global settings.json
- [x] Agente **Guru** (skill `/guru`)
- [x] Agente **DeliveryManager** (skill `/delivery`)
- [x] Agente **Tester** (skill `/tester`)
- [x] Agente **Doc** (skill `/doc`, unificando `/doc nueva`, `/doc refinar`, `/doc priorizar`)
- [x] Agente **Planner** (skill `/planner` — planificación, sprint, propuestas, digest)
- [x] Instalar `gh` CLI 2.86.0 y migrar todos los skills de `curl` a `gh`
- [x] Mejorar MEMORY.md con patrones de arquitectura y debugging (completado con reporte de Guru)
