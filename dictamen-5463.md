## Dictamen de integridad técnica — issue #5463

**Alcance evaluado:** rama `agent/5463-pipeline-dev` @ `905303622`, diff vs `origin/main` (7 archivos, +943/-38).

### Adherencia al diseño/diagramas

**Adherente.** La verificación formal de adherencia contra receta firmada es **N/A**: el gate architect corre con `enabled: false` / `gate_mode: dry-run`, por lo que Fase 1 nunca produjo sección `## Detalles Técnicos` firmada contra la cual comparar el diff (`evaluateGate` → `decision: aprobado`, `skipped: true`, `gate_mode: disabled`). En ausencia de receta, se evaluó la implementación contra el diseño declarado en el issue (D1..D6 de #5339, CA-5 y guardas de CA-6 del padre #5451).

Los cuatro cambios requeridos por el issue están implementados y verificados empíricamente:

- Inventario sensible ampliado con `.pipeline/credentials.json` y `.pipeline/telegram-config.json` (`.gitignore:31-32`), más material criptográfico, `.aws/credentials`, `.npmrc` y configs Firebase/Google.
- Excepción `!.env.example` preservada y efectiva (`check-ignore` la resuelve por la regla negada `.gitignore:27`, pese a `.env.*`).
- `.husky/pre-commit` alineado: dejó de declarar lista propia y deriva del módulo compartido.
- Suite `credential-path-guards.test.js` (426 líneas) ejercitando `git check-ignore -v --no-index` + `git ls-files`: **15/15 verde**.

La decisión estructural de fondo — un **inventario cerrado como fuente única de verdad** en `.pipeline/lib/sensitive-paths.js` del que derivan las tres capas (ignore / scanner / tests) — es la respuesta correcta al defecto de origen: antes cada capa tenía su lista hardcodeada y divergían, y los dos stores de credenciales del pipeline no estaban en ninguna.

### Desvíos vs. diseño

Ninguno que contradiga el diseño. Dos observaciones registradas, ambas coherentes:

- `.pipeline/commander-session.json` se **elimina del índice** en el diff. No es un archivo espurio: es exactamente lo que exige el CA "`git ls-files` confirma que ninguno de esos paths está trackeado". Es un archivo de estado runtime regenerado localmente por el Commander, no una fuente versionada.
- El módulo incorpora entradas con `requiereIgnore: false` (`claude-hooks-telegram-config`, `servicios-state`), que **no** son un desvío sino una decisión explícita y comentada: son paths hoy trackeados legítimamente donde un ignore taparía un archivo versionado; su contención pasa a ser escaneo de contenido.

### Deuda técnica / riesgos introducidos

- **Deuda heredada, explicitada y con dueño:** `claude-hooks-telegram-config` (bot_token + chat_id + openai_api_key) sigue **trackeado**, cubierto sólo por escaneo de contenido hasta que #5226 haga el destrackeo. La implementación no lo oculta — lo documenta en el módulo con el issue responsable. Es la exposición residual real de esta entrega y queda fuera de su alcance.
- **Riesgo de deriva a futuro:** el valor del diseño depende de que las altas se hagan en el módulo y no en `.gitignore`. Mitigado estructuralmente: el test falla si `.gitignore` no refleja el inventario, y hay un test específico ("el scanner deriva su inventario del módulo compartido, sin lista paralela") que impide reintroducir listas paralelas.
- **Efecto colateral menor:** al destrackear `commander-session.json`, un `reset --hard` de respawn ya no lo restaura desde el repo. Sin impacto operativo — el Commander lo regenera, y su contenido (mensajes pegados por el operador) era precisamente el vector de fuga.
- **Sin deuda de higiene de evidencia:** el módulo declara paths y reglas, nunca contenido; los tests y el scanner tampoco vuelcan contenido de archivos sensibles. Cumple el CA "la evidencia no incluye contenido de archivos sensibles ni dumps de entorno".

### Integridad estructural

**Sólida.** El cambio reduce superficie en vez de agregarla: sustituye tres listas divergentes por una fuente única con matchers explícitos (`test(rel)` por entrada, sin glob casero — que es justamente donde estas guardas fallan en silencio). Mantiene el comportamiento fail-closed del scanner y respeta la defensa en profundidad: `.gitignore` como primera capa, pre-commit como segunda ante `git add -f` o des-ignore. La cobertura de tests es proporcional al riesgo (15 casos incluyendo CRLF, excepciones, y no-clasificación de archivos legítimos como falsos positivos). No introduce dependencias nuevas ni refactor invasivo fuera del perímetro del issue.
