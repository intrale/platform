*📋 Listado de issues · {{filter-description}}*

{{#if empty}}
_No hay issues que matchen el filtro._

Probá:
  `listado pendientes`
  `listado en curso`
  `listado de la ola`
{{else}}

*Total:* {{total}} · *Mostrando:* {{shown}}{{#if truncated}} _(top {{shown}} por prioridad)_{{/if}}

{{#each issues}}
{{priority-icon}} \#{{number}} · {{labels}}
   _{{title}}_
   ↪ `{{phase}}` · {{state}}{{#if elapsed}} · {{elapsed}}{{/if}}
{{/each}}

{{#if truncated}}
_Para ver todos: `listado todo` (puede ser largo)_
{{/if}}
{{/if}}

_Fuente: GitHub API cacheada · sin LLM_
