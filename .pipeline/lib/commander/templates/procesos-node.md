*⚙️ Procesos Node del pipeline · {{timestamp}}*

*Total:* {{total-count}} procesos · *RAM total:* {{total-ram-human}}

━━━━━━━━━━━━━━━━━━━━

{{#each processes}}
{{status-icon}} `{{role}}` · PID {{pid}}
   ↪ CPU {{cpu-percent}}% · RAM {{ram-human}} · uptime {{uptime}}
{{#if is-zombie}}   ⚠️ _proceso zombi — sugerido: `/ghostbusters`_{{/if}}
{{/each}}

{{#if has-orphans}}
━━━━━━━━━━━━━━━━━━━━

🚨 *Procesos huérfanos detectados:* {{orphan-count}}
{{#each orphans}}
  • PID {{pid}} · `{{cmdline-redacted}}`
{{/each}}
{{/if}}

_Comando determinístico · `ps`/`tasklist` con argv array · redacción CA-9 aplicada_
