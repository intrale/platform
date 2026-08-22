*🔐 Allowlist · `.partial-pause.json`*

{{#if full-pause}}*Estado:* 🔴 halt total{{#if pause-origin}} · _{{pause-origin}}_{{/if}}
⛔ Pipeline detenido por completo. La allowlist NO aplica mientras el halt esté activo.
{{#if count}}_(hay {{count}} issues autorizados, en espera de que se levante el halt.)_
{{/if}}{{else}}*Estado:* {{#if active}}🟡 pausa parcial activa · {{window-label}}{{else}}🟢 sin pausa parcial{{/if}}
{{/if}}*Última modificación:* {{last-modified}}

━━━━━━━━━━━━━━━━━━━━

{{#if empty-allowlist}}
{{#if has-skills}}*Skills admitidos ({{skills-count}}):* {{skills-display}}

⚠️ Ventana por skill vigente: el dispatch está restringido a esos skills. NO es *running normal*.
{{else}}_Allowlist vacía._

{{#if active}}⚠️ Pausa parcial activa con allowlist vacía → equivale a *running normal*.{{/if}}
{{/if}}

{{else}}

*Issues admitidos ({{count}}):*
{{#if compact}}
{{{compact-list}}}
{{else}}
{{#each issues}}
  ✅ \#{{number}} · {{title-short}}{{#if labels-display}} · {{labels-display}}{{/if}}
{{/each}}
{{/if}}
{{#if truncated}}
_… y {{hidden-count}} más de los {{count}} autorizados \(sólo se listan {{shown}} para que el mensaje entre en Telegram\)._
_La allowlist NO está incompleta: los {{count}} siguen autorizados. La lista entera está en el tablero._
{{/if}}
{{#if has-skills}}
*Skills admitidos ({{skills-count}}):* {{skills-display}}
{{/if}}

{{#if con-deps-recursivas}}
*Dependencias incluidas recursivamente:*
{{#each deps}}
  ↪ \#{{number}} _(dep de \#{{parent}})_
{{/each}}
{{/if}}

{{/if}}

━━━━━━━━━━━━━━━━━━━━

_Para modificar: pedile a Leo \(allowlist no se toca sin OK explícito\)._
_Comando determinístico de solo lectura · sin LLM_
