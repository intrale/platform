# Mecanismo de reintento para preguntas de permiso expiradas

> Issue: #1009
> Fecha: 2026-02-27

## Problema

Cuando un agente solicita un permiso via `permission-approver.js`, el hook envia un
mensaje con inline buttons a Telegram y hace polling. Si el usuario no responde
a tiempo (por defecto 60 min), la pregunta se marca como `expired` y el agente
continua sin el permiso (fallback al prompt local o se detiene).

**Caso concreto:** En la sesion del 26/02/2026, 6 de 17 preguntas expiraron durante
el flujo de QA Android, obligando a relanzar todo el flujo.

## Analisis de opciones

### Opcion A: Re-inyectar respuesta al agente original
- **Viabilidad:** No viable. El proceso de Claude Code que genero la pregunta ya
  termino. No hay mecanismo de IPC para inyectar una respuesta a un proceso muerto.
- **Descartada.**

### Opcion B: Cola persistente con replay de acciones
- **Descripcion:** Al expirar, encolar la accion (ej: comando Bash). Al recibir
  respuesta tardia, ejecutar la accion desde el commander.
- **Problemas:**
  - Solo funciona para Bash simples. Task/Skill requieren contexto del agente.
  - Seguridad: ejecutar comandos fuera de contexto puede ser peligroso.
  - El orden importa: si la accion #3 dependia de #1 y #2, ejecutar #3 sola falla.
- **Descartada** para ejecucion directa.

### Opcion C: Persistir permiso como "siempre" (ELEGIDA)
- **Descripcion:** Al responder una pregunta expirada, persistir el permiso en
  `settings.local.json` para que la proxima vez se auto-apruebe.
- **Ventajas:**
  - Simple, seguro, sin efectos secundarios.
  - Reutiliza `persistAlways()` que ya existe.
  - El usuario solo tiene que relanzar el agente/flujo una vez.
- **Desventaja:** No ejecuta la accion inmediatamente, solo garantiza que la
  proxima ejecucion sera automatica.
- **Trade-off aceptable:** El costo de relanzar es bajo vs. el riesgo de ejecutar
  comandos fuera de contexto.

## Implementacion

### Flujo de timeout (permission-approver.js)

Antes:
```
Timeout → editar mensaje "Sin respuesta" (sin botones) → exit(0)
```

Despues:
```
Timeout → editar mensaje con boton "Reactivar" → exit(0)
         ↓ (si el usuario toca "Reactivar" mas tarde)
         → commander captura callback → persistAlways() → notificar
```

### Comando /retry (telegram-commander.js)

Nuevo comando que lista preguntas expiradas de las ultimas 24h con botones:
- **Reactivar**: persiste el permiso y cambia status a `retried`
- **Descartar**: cambia status a `answered`
- **Reactivar todas**: aplica "Reactivar" a todas las expiradas

### Nuevas funciones (pending-questions.js)

- `getExpiredQuestions()`: filtra preguntas con status `expired` de las ultimas 24h
- `retryQuestion(id)`: cambia status a `retried`, retorna `action_data`

### Callbacks manejados por el commander

| Callback data         | Accion                                    |
|-----------------------|-------------------------------------------|
| `reactivate:<id>`     | Persistir permiso + marcar como `retried` |
| `dismiss_expired:<id>`| Marcar como `answered` + quitar botones   |
| `reactivate_all`      | Reactivar todas las expiradas             |

## Limitaciones conocidas

1. **No re-ejecuta la accion original.** Solo persiste el permiso para futuras ejecuciones.
2. **Solo funciona para tools con patron persistible** (Bash, WebFetch, WebSearch, Skill).
   Tools como Edit/Write/Read no generan patrones.
3. **Ventana de 24h.** Preguntas mas viejas se limpian automaticamente.
4. **El commander debe estar corriendo** para capturar los callbacks de "Reactivar".

## Diagrama de flujo

```
permission-approver.js                telegram-commander.js
        |                                     |
        | timeout                              |
        |──→ editMessage(boton "Reactivar")    |
        | exit(0)                              |
        |                                      |
        |        [usuario toca "Reactivar"]     |
        |                                      |←── callback_query
        |                                      | retryQuestion(id)
        |                                      | persistPattern()
        |                                      | editMessage("Reactivado")
        |                                      |
        |        [usuario envia /retry]         |
        |                                      |←── message
        |                                      | getExpiredQuestions()
        |                                      | sendMessage(lista + botones)
```

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `.claude/hooks/pending-questions.js` | `getExpiredQuestions()`, `retryQuestion()` |
| `.claude/hooks/permission-approver.js` | Boton "Reactivar" en mensaje expirado |
| `.claude/hooks/telegram-commander.js` | Comando `/retry`, callbacks `reactivate:` |
| `docs/hooks-expired-questions.md` | Este documento |
