*🔐 Allowlist · `.partial-pause.json`*

*Estado:* {{#if active}}🟡 pausa parcial activa{{else}}🟢 sin pausa parcial{{/if}}
*Última modificación:* {{last-modified}}{{#if last-modified-by}} _por {{last-modified-by}}_{{/if}}

━━━━━━━━━━━━━━━━━━━━

{{#if empty-allowlist}}
_Allowlist vacía._

{{#if active}}⚠️ Pausa parcial activa con allowlist vacía → equivale a *running normal*.{{/if}}

{{else}}

*Issues admitidos ({{count}}):*
{{#each issues}}
  ✅ \#{{number}} · {{title-short}}{{#if labels-display}} · {{labels-display}}{{/if}}
{{/each}}

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
