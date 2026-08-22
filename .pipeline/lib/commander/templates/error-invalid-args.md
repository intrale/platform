⚠️ *Args no válidos para `{{command}}`*

{{validation-error-message}}

━━━━━━━━━━━━━━━━━━━━

*Uso esperado:*
```
{{usage-example}}
```

{{#if allowed-values}}
*Valores permitidos:*
{{#each allowed-values}}
  • `{{this}}`
{{/each}}
{{/if}}

{{#if hint}}
💡 _{{hint}}_
{{/if}}

_Validación CA-8 · pista determinística \(no se delega al LLM\)_
