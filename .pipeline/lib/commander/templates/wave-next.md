{{#if has-next}}
*Próxima ola: \#{{wave-number}}*{{#if has-goal}} — _{{goal}}_{{/if}}

━━━━━━━━━━━━━━━━━━━━

{{#if has-issues}}
*Candidatos \({{issues-count}}\):*

{{#each issues}}
  • \#{{number}}{{#if has-size}} · `{{size}}`{{/if}} · _{{rationale}}_
{{/each}}

{{else}}
_Ola sin candidatos cargados todavía._
{{/if}}

━━━━━━━━━━━━━━━━━━━━

_Datos: `.pipeline/waves.json` · sin LLM_
{{else}}
*Próxima ola*

_No hay ola próxima planificada todavía._ Cuando el planner componga la siguiente, va a aparecer acá.

_Datos: `.pipeline/waves.json` · sin LLM_
{{/if}}
