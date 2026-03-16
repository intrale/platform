# Plantilla de estructura de issue

Usar esta estructura al redactar o refinar cualquier issue:

```markdown
## Objetivo

Propósito conciso de la historia. Una o dos oraciones que expliquen el "qué" y el "para qué".

## Contexto

- Comportamiento actual (si aplica)
- Antecedentes relevantes
- Dependencias con otros issues (si las hay)

## Cambios requeridos

1. **[Módulo/Capa]** — Descripción del cambio
   - Archivo: `ruta/completa/al/archivo.kt`
   - Detalle de la modificación
2. **[Módulo/Capa]** — Siguiente cambio
   - Archivo: `ruta/completa/al/archivo.kt`

## Criterios de aceptación

- [ ] Criterio verificable 1
- [ ] Criterio verificable 2
- [ ] Tests pasan (`./gradlew check`)
- [ ] Sin regresiones en módulos afectados

## Escenarios Gherkin

> Obligatorio: mínimo 2 escenarios (happy path + caso de error).
> Usar formato Given/When/Then en español (Dado/Cuando/Entonces).

```gherkin
Escenario: [Happy path — flujo principal exitoso]
  Dado que [precondición: usuario autenticado, datos existentes, estado previo]
  Cuando [acción principal del usuario]
  Entonces [resultado esperado visible para el usuario]
  Y [efecto secundario: datos persistidos, estado cambiado]

Escenario: [Caso de error — validación, permisos o estado inválido]
  Dado que [precondición que genera el error]
  Cuando [acción del usuario]
  Entonces el sistema muestra error "[mensaje específico]"
  Y NO se modifica el estado previo
```

**Reglas:**
- Cada escenario debe ser autocontenido (precondiciones explícitas)
- Usar datos realistas (nombres argentinos, direcciones reales, montos en ARS)
- Los mensajes de error deben ser específicos (no "Error genérico")
- Agregar más escenarios según complejidad: permisos, edge cases, transiciones de estado

## Notas técnicas

- Consideraciones de implementación
- Patrones a seguir (ej: patrón Do/Comm, sistema de strings)
- Riesgos o alternativas descartadas
```

## Reglas de redaccion

- Nombrar clases, archivos y endpoints exactos con rutas completas del workspace
- Evitar referencias vagas ("el componente", "la pantalla")
- Incluir pruebas, docs y configuracion si aplica
- Redaccion clara, sin ambiguedades
- Lenguaje tecnico y accionable
