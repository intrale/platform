## Objetivo

Generar **baseline cuantitativo** de ahorro que tendría el rol Arquitecto si hubiera intervenido en issues reales ya cerrados.

## Contexto

El issue #3507 (spec del rol Arquitecto) propone reducción de costo de -30-50% mediante uso de Sonnet 4.6/Haiku 4.5 en lugar de Opus para exploración técnica. Esta tarea produce **evidencia numérica real** sobre 3 issues ya implementados para validar la hipótesis.

Datos a extraer de `.pipeline/audit/*.jsonl`:
- Tokens gastados por el dev en **fase de exploración técnica** (primeras 2-4 horas, antes de implementación real)
- Costo en Opus 4.7 (actual)
- Estimación de costo hipotético con Sonnet 4.6 (aprox 1/3 a 1/2 del costo Opus)
- Ahorro % = (costo Opus - costo Sonnet) / costo Opus × 100
- Análisis de rebotes: ¿cuántos fueron evitables con receta técnica del Arquitecto?

## Specs de referencia

N/A (análisis retrospectivo, sin impacto en API/UI)

## Cambios requeridos

**Entregable único:** documento con tabla + gráfico + conclusión.

### Tabla de análisis (3 issues)

| Issue # | Título | Tokens exploración | Costo Opus | Costo Sonnet est. | Ahorro $ | Ahorro % | Rebotes | Evitables |
|---------|--------|-------------------|-----------|------------------|-----------|----------|---------|-----------|
| A rellenar | ... | ... | ... | ... | ... | ... | ... | ... |

### Gráfico ASCII (barras Opus vs Sonnet)

```
Costo comparativo (3 issues)

[Gráfico a generar con datos reales]
```

### Conclusión

Texto confirmando rango de ahorro proyectado (25-45% o el que salga real).

## Criterios de aceptación

- [ ] 3 issues cerrados recientes seleccionados (últimas 2-4 semanas)
- [ ] Tokens de exploración extraídos de audit JSONL para cada uno
- [ ] Costos Opus calculados (usar tarifa vigente $0.015/1K input + $0.060/1K output)
- [ ] Costos Sonnet 4.6 estimados (1/3 a 1/2 vs Opus)
- [ ] Tabla con 3 filas, todos los campos rellenos
- [ ] Gráfico ASCII de barras mostrando comparativa visual
- [ ] Análisis de rebotes: identificados y estimación de evitables
- [ ] Conclusión con rango de ahorro confirmado
- [ ] Documento agregado como comentario en #3507 cuando esté listo

## Notas técnicas

- **Tipo de tarea:** análisis retrospectivo puro. NO requiere código, NO requiere testing, NO requiere cambios a features.
- **Datos:** ya existen en `.pipeline/audit/*.jsonl` — solo se requiere lectura, parsing y cálculo.
- **Precisión:** es una estimación, no un valor exacto. Los valores de Sonnet son hipotéticos porque no hay audits reales con ese modelo. La estimación 1/3-1/2 se basa en ratios precio/performance conocidos.
- **Selección de issues:** elegir preferentemente bugs o enhancements de complejidad media con dev completado hace 2-4 semanas y buenos datos de audit.
- **Formato de salida:** documento único (markdown), luego comentado en #3507.

## Contexto adicional

Sesión Leo 2026-05-25: la validación cuantitativa es necesaria antes de pasar #3507 a implementación. Este análisis lo habilita.
