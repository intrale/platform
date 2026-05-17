# Plantillas Markdown del Commander Determinístico

Sistema de **respuestas versionadas** para la pista determinística del Telegram
Commander (issue #3257 — CA-3 / CA-12). Cada respuesta del Commander que NO
invoca LLM se arma con una plantilla `.md` de este directorio, rellenada con
datos crudos vía `lib/commander/fill-template.js`.

> **Por qué archivos `.md` y no strings hardcoded:**
> 1. **Diff legible** — un cambio de copy lo aprueba UX sin tocar `pulpo.js`.
> 2. **Reutilización** — la misma plantilla la puede consumir el dashboard
>    (vista previa) sin parsear lógica.
> 3. **Test de regresión** — snapshot test sobre el output de
>    `fillTemplate(name, fixture)` valida la copia sin levantar Telegram.
> 4. **Seguridad** — separar contenido de lógica permite auditar cada placeholder
>    y aplicar `escapeMarkdownV2` consistentemente (CA-12).

## Convención de placeholders

Sintaxis Handlebars básica, sin lógica embebida:

```handlebars
{{variable}}            — reemplazo simple, escape MarkdownV2 automático
{{{variable}}}          — reemplazo SIN escape (solo para fragmentos ya seguros, ej. otra plantilla)
{{#each items}}...{{/each}}   — iteración sobre arrays
{{#if condition}}...{{/if}}   — condicional binario
{{#if condition}}...{{else}}...{{/if}}
```

**Reglas:**

- Todo `{{var}}` simple pasa por `escapeMarkdownV2(value)` antes de inyectar.
- `{{{var}}}` (triple-brace) solo se usa cuando el valor ya es Markdown válido
  generado por otra plantilla (ej. composición de bloques).
- Los placeholders son `kebab-case`: `{{issue-number}}`, `{{phase-name}}`.
- Las condiciones (`{{#if x}}`) tratan `null`/`undefined`/`""`/`0`/`false` como
  falsy. No hay operadores; si necesitás lógica más rica, computala en el
  handler antes de pasar el data.

## Convenciones de UX (tono y voz)

- **Idioma:** español rioplatense, voseo informal pero claro. Sin tecnicismos
  innecesarios cuando hay sinónimo natural ("agentes activos" mejor que
  "PIDs activos del coordinator").
- **Largo:** Telegram en móvil — máximo ~20 líneas visibles sin scroll. Los
  comandos verbosos (`/status`, `snapshot`) usan secciones colapsables visuales
  (separadores `━━━` o emojis al margen).
- **Emoji:** uso semántico, NO decorativo. Cada emoji codifica estado o categoría:
  - 🟢 ok / 🟡 stale / 🔴 error / 🟣 LLM / ⚙️ determinístico
  - 🌊 ola / 📋 listado / 🔐 allowlist / 📜 logs / 📸 screenshot / 🐙 pulpo
  - 😴 modo descanso / 💤 inactivo / ⏰ alarma
- **Errores y rate limits:** tono amable, NUNCA culpabilizador. "Esperá 30s"
  mejor que "Demasiados pedidos rechazados". Siempre incluir el próximo paso.
- **Timestamps:** formato `HH:mm` para hoy, `dd-mm HH:mm` si es de otro día,
  zona horaria `America/Argentina/Buenos_Aires` implícita (es local). Si la
  data viene en UTC, convertir en el handler.
- **Números grandes:** formato `1.234` (punto miles), no comas. Porcentajes
  con un decimal cuando hay precisión real (`78.4%`), sin decimal cuando es
  estimación (`~25%`).

## Inventario de plantillas

| Archivo                       | Comando origen                     | CA cubierto |
|-------------------------------|------------------------------------|-------------|
| `status.md`                   | `/status`                          | CA-2 #1     |
| `snapshot-ola.md`             | `snapshot de ola`                  | CA-2 #1     |
| `listado-issues.md`           | `listado de issues`                | CA-2 #2     |
| `allowlist.md`                | `allowlist` (read-only)            | CA-2 #3     |
| `tail-logs.md`                | `tail de logs <archivo>`           | CA-2 #4 / CA-8 |
| `dashboard-up.md`             | `levantar dashboard`               | CA-2 #5     |
| `dashboard-down.md`           | `bajar dashboard`                  | CA-2 #5     |
| `screenshot.md`               | `screenshot de Telegram`           | CA-2 #6     |
| `procesos-node.md`            | `procesos node`                    | CA-2 #7     |
| `salud-pulpo.md`              | `salud del pulpo`                  | CA-2 #8     |
| `modo-descanso.md`            | `modo descanso lookup`             | CA-2 #9     |
| `error-rate-limit.md`         | (cualquiera, gate CA-11)           | CA-11       |
| `error-unknown.md`            | comando no clasificado             | CA-1 / CA-7 |
| `error-invalid-args.md`       | args no validan schema             | CA-8        |

## Cómo agregar una plantilla

1. Crear `lib/commander/templates/<nombre>.md` usando los placeholders documentados.
2. Agregar entrada en este README (tabla "Inventario").
3. Sumar fixture en `__tests__/commander-templates.test.js`:
   ```js
   test('plantilla <nombre> snapshot', () => {
     const out = fillTemplate('<nombre>', fixtures.nombre);
     assert.match(out, /esperado/);
   });
   ```
4. Registrar handler en `lib/commander-deterministic.js` con su entrada
   en el allowlist (CA-7) y su validación de args (CA-8).

## Verificación visual

Para previsualizar cómo se ve una plantilla en Telegram sin enviarla:

```bash
node -e "console.log(require('./.pipeline/lib/commander/fill-template')('status', require('./.pipeline/lib/commander/templates/fixtures/status.json')))"
```

Pegar el output en cualquier visor Markdown que soporte MarkdownV2 (Telegram
Web, o el preview del repo en GitHub) para validar render.

## Referencia

- Issue origen: #3257
- Tokens visuales del dashboard (card CA-4): `.pipeline/assets/design-tokens.css`
- Mockup del card: `.pipeline/assets/mockups/15-commander-routing-metric.svg`
- Doc operativa: `docs/pipeline/telegram-commander.md` (entrega CA-5)
