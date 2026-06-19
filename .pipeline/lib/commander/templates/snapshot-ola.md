*🌊 Snapshot de Ola {{ola-numero}} · {{timestamp}}*

*Progreso:* `{{progress-bar}}` *{{progress-percent}}%*
*ETA:* {{eta-human}} _(modelo {{eta-model}})_
{{#if blocked-count}}*Bloqueados:* {{blocked-count}} _— requieren intervención_{{/if}}

━━━━━━━━━━━━━━━━━━━━

*Issues de la ola ({{total-issues}}):*

{{#each issues}}
{{status-icon}} \#{{number}} · `{{phase}}`{{#if blocked}} 🔒{{/if}}
   _{{title}}_
{{#if delivery-note}}   ⚠️ {{{delivery-note}}}{{/if}}
{{#if last-event}}   ↪ {{last-event}} · {{last-event-elapsed}}{{/if}}
{{/each}}

━━━━━━━━━━━━━━━━━━━━

{{#if intervencion-requerida}}
⚠️ *Intervención humana sugerida:*
{{#each intervencion-items}}
  • \#{{number}} — {{reason}}
{{/each}}
{{else}}
✅ _Ola avanzando sin bloqueos críticos._
{{/if}}

_Datos: filesystem `.pipeline/desarrollo/*` · sin LLM_
