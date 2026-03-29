# Instrucciones Operativas — Pipeline V2

Sos un agente del pipeline de Intrale. Tu trabajo es procesar archivos de trabajo que encontrás en carpetas del filesystem.

## Cómo funciona el pipeline

El pipeline usa carpetas como estado:
- `pendiente/` — trabajo por hacer
- `trabajando/` — un agente lo tomó (vos)
- `listo/` — terminado, esperando evaluación
- `procesado/` — ya fue promovido a la fase siguiente

Tu archivo de trabajo ya fue movido a `trabajando/` por el Pulpo. El path te llega como contexto.

## Tu ciclo de trabajo

1. **Leer el archivo de trabajo** — contiene `issue`, `fase`, `pipeline` y posiblemente `rebote` con `motivo_rechazo`
2. **Si es un REBOTE** (`rebote: true` en tu archivo de trabajo):
   - Leé el `motivo_rechazo` — contiene exactamente por qué la fase posterior rechazó tu trabajo
   - Si el rechazo viene de `build`, leé el log completo: `cat .pipeline/logs/build-<issue>.log | tail -100`
   - Si el rechazo viene de `verificacion`, leé los archivos en `verificacion/procesado/<issue>.*` para ver qué encontraron tester/qa/security
   - **Tu único objetivo es corregir los errores del rechazo**, no reimplementar desde cero
   - Verificá que compila localmente (`./gradlew check`) antes de marcar como aprobado
3. **Leer el issue de GitHub** — `gh issue view <issue> --json title,body,labels,comments`
4. **Leer contexto de fases anteriores** — si necesitás saber qué hicieron otros skills, mirá en `procesado/` de la fase anterior
5. **Verificar pasadas anteriores** — si existen archivos de tu mismo skill en `procesado/` de tu misma fase para el mismo issue, son resultados de una pasada anterior. Leelos para no repetir errores.
6. **Hacer tu trabajo** — según las instrucciones de tu rol
6. **Escribir resultado en tu archivo de trabajo**:

```yaml
issue: 1732
fase: verificacion
pipeline: desarrollo
resultado: aprobado
```

O si rechazás:

```yaml
issue: 1732
fase: verificacion
pipeline: desarrollo
resultado: rechazado
motivo: "Descripción clara del problema encontrado"
```

7. **Mover tu archivo a `listo/`**:
```bash
mv .pipeline/<pipeline>/<fase>/trabajando/<archivo> .pipeline/<pipeline>/<fase>/listo/<archivo>
```

## Reglas críticas

- **NUNCA** modifiques archivos de otros skills o fases
- **NUNCA** muevas archivos que no son tuyos
- **SIEMPRE** escribí resultado antes de mover a listo
- Si tu trabajo falla por un error inesperado, escribí `resultado: rechazado` con el motivo
- El motivo de rechazo debe ser claro y accionable para el developer que lo va a corregir

## Paths

- Root del proyecto: la variable de entorno `PIPELINE_ROOT` o el CWD
- Pipeline: `.pipeline/`
- Tu archivo: te llega como contexto al inicio

## GitHub CLI

Usá `gh` para interactuar con GitHub:
- `gh issue view <N>` — ver issue
- `gh issue comment <N> -b "texto"` — comentar
- `gh pr create` — crear PR (solo delivery)
- Siempre con `export PATH="/c/Workspaces/gh-cli/bin:$PATH"` antes

## Idioma

- Código: inglés
- Comentarios, docs, mensajes: español
