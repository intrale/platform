## Recomendaciones futuras (issues separados creados por guru)

Como parte del análisis técnico de este issue, identifiqué 2 oportunidades complementarias que **NO bloquean** este wire-up pero conviene registrar como issues independientes:

- **#3571** `[guru] Extender wire-up in-flight fallback a la rama non-Anthropic de ejecutarClaude` — cubrir el caso "fallback ya activo cae mid-flight". priority:low.
- **#3572** `[guru] Detector multi-señal D — auto-quarantine de provider por burst de fallos >70%/5min` — defensa en profundidad cross-turn (señal D del mapeo A-E propuesto por Leo el 2026-05-26). priority:low.

Ambos están etiquetados `tipo:recomendacion + needs-human` y **NO entran al pipeline** hasta que un humano los apruebe (`recommendation:approved`).
