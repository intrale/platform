{{#if variant-1}}
✓ *Tomado: rechazo \#{{issue}} en `{{fase-display}}`*

{{#if motivo}}
> {{motivo}}
{{/if}}

Rebobinado en cola — el pipeline lo retoma desde `{{fase-resolved}}` cuando se libere el slot.

_Audit: `{{audit-ref}}`_
{{/if}}
{{#if variant-2}}
✓ *Listo, \#{{issue}} vuelve a `{{fase-display}}`*

{{#if motivo}}
Motivo guardado: _{{motivo}}_
{{/if}}

Lo encolé al rebobinador \(`{{fase-resolved}}`\). Si \#3416 todavía no consume, queda como evento en `.pipeline/rejections/`.

_Audit: `{{audit-ref}}`_
{{/if}}
{{#if variant-3}}
✓ *Anotado: \#{{issue}} pal\' rebobinador en `{{fase-display}}`*

{{#if motivo}}
Lo que entendí: _{{motivo}}_
{{/if}}

Queda en cola — `{{fase-resolved}}`. Si la transcripción salió torcida, mandá `/rechazar` de nuevo con texto.

_Audit: `{{audit-ref}}`_
{{/if}}
