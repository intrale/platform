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
