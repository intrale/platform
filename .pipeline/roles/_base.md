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
2. **Si es un REBOTE** (`rebote: true` en tu archivo de trabajo): seguí el **Protocolo de rebote** más abajo ANTES de cualquier otro paso.
3. **Leer el issue de GitHub** — `gh issue view <issue> --json title,body,labels,comments`
4. **Leer contexto de fases anteriores** — si necesitás saber qué hicieron otros skills, mirá en `procesado/` de la fase anterior
5. **Verificar pasadas anteriores** — si existen archivos de tu mismo skill en `procesado/` de tu misma fase para el mismo issue, son resultados de una pasada anterior. Leelos para no repetir errores.
6. **Hacer tu trabajo** — según las instrucciones de tu rol
7. **Escribir resultado en tu archivo de trabajo** (que sigue en `trabajando/`):

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

8. **Salir con código 0** — el Pulpo detecta tu salida y mueve el archivo de `trabajando/` a `listo/`.

## Protocolo de rebote (CRÍTICO)

Si tu archivo de trabajo tiene `rebote: true` (o cualquier campo `motivo_rechazo`, `rechazado_en_fase`, `rebote_numero`), **NO estás arrancando desde cero** — alguien ya intentó antes y una fase posterior rechazó con motivo específico. Tratá el rechazo como input **al mismo nivel de autoridad que los criterios de aceptación del issue**.

Tres reglas inquebrantables:

### 1. El `motivo_rechazo` NO es una sugerencia, es la única observación que importa

- Leé el `motivo_rechazo` **completo**, hasta el final. Ignorar partes del texto es una forma común de fallar de nuevo por lo mismo.
- Identificá **cada claim específico** que hace el rechazo. Ejemplos reales:
  - "El archivo X no existe" → claim verificable con `ls` / `test -f` / `stat`.
  - "Los íconos son visualmente idénticos" → claim verificable con `md5sum` / `diff` / inspección del recurso.
  - "La función Y no respeta el patrón Z" → claim verificable leyendo el código y comparándolo con el patrón.
  - "Tests del módulo M fallan" → claim verificable con `./gradlew :M:test`.

### 2. Verificás cada claim empíricamente en ESTE ciclo (no citar estado sin comprobar)

- Prohibido aprobar citando archivos, paths, hashes o comandos sin haberlos ejecutado y observado su salida real en esta misma pasada.
- Por cada claim del rechazo, ejecutás el comando concreto de verificación y **pegás el output textual** en las `notas` del resultado. Ejemplos:
  ```
  ## Verificación del rechazo rev-<N>

  CA-1 ("carpetas X y Y no existen"):
  $ ls -la app/composeApp/src/{X,Y}/res 2>&1
  <output REAL>

  CA-4 ("íconos visualmente idénticos"):
  $ md5sum app/composeApp/src/*/res/mipmap-mdpi/ic_launcher.png
  <hashes REALES>
  ```
- Si el rechazo menciona varios claims, los verificás **todos**. Un solo claim sin verificar arruina la aprobación.

### 3. El veredicto depende del resultado empírico, no de lo que creés

- Si la verificación confirma que el claim sigue siendo válido (el problema persiste) → `resultado: rechazado` con motivo explícito. NO aprobás "porque igual lo arreglé en otro lado".
- Si la verificación muestra que el claim ya no aplica (el problema se resolvió), aprobás **adjuntando la evidencia** que lo demuestra.
- Si no podés verificar un claim porque te falta contexto, información o herramienta, **rechazá pidiendo ese contexto** — no asumas.
- Si encontrás un desacuerdo con el rechazo (creés que el reviewer se equivocó), argumentalo con evidencia concreta de archivos/líneas/outputs, no con interpretación.

### Anti-patrones a evitar

- "Ya estaba resuelto en un commit anterior / en otra rama / en el worktree del agente" → no sirve. **Lo que importa es el estado del HEAD que va a evaluar la siguiente fase**.
- "El build compila exitosamente" → insuficiente. Un build OK no prueba que los assets/recursos/configuración por flavor/perfil estén bien diferenciados.
- "Hice merge con main y ya está" → verificá empíricamente qué quedó en el merge. El merge no arregla claims del rechazo por sí solo.
- "Los tests pasan" → los tests unitarios rara vez cubren assets visuales, configs por flavor, recursos. Verificá específicamente lo que pide el rechazo.

### Si el rebote viene de una fase posterior específica

- **Rechazo de `build`**: leé el log completo: `cat .pipeline/logs/build-<issue>.log | tail -200`. Verificá compilación real con `./gradlew <tarea> --no-daemon`.
- **Rechazo de `verificacion`**: leé los YAMLs en `.pipeline/desarrollo/verificacion/procesado/<issue>.*` y el PDF en `logs/rejection-<issue>-<skill>.pdf` si existe. Si hay video QA, mirá el frame donde se evidencia el defecto (`qa/evidence/<issue>/screenshot-*.png`).
- **Rechazo de `aprobacion`** (review): leé la review en el PR con `gh pr view <N> --json reviews`.

## Reglas críticas

- **NUNCA** muevas vos el archivo de `trabajando/` a `listo/` — el Pulpo es el único dueño del lifecycle del archivo. Si lo movés, se produce una carrera: el Pulpo on-exit intenta leer `trabajando/` después de que vos ya moviste, encuentra un archivo vacío, pierde tu `resultado` y te rechaza por "evidencia incompleta" aunque hayas aprobado.
- **NUNCA** modifiques archivos de otros skills o fases
- **NUNCA** muevas archivos que no son tuyos
- **SIEMPRE** escribí el resultado en `trabajando/` antes de salir
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
