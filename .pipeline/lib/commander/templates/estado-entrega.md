📦 *Estado de entrega* — \#{{numero}}

{{#if is-mergeado}}✅ *Entregado* — mergeado en `main`
{{citation}}{{/if}}{{#if is-pusheado}}🟡 *Pusheado, SIN merge a* `main` *todavía*
{{citation}}{{/if}}{{#if is-pipeline}}🔵 *En pipeline* — fase {{fase}}
{{citation}}{{/if}}{{#if is-no-verificable}}🤷 *No verificable* — sin datos determinísticos \(no asumir "no entregado"\)
{{citation}}{{/if}}
