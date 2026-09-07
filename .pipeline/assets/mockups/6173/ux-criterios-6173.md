## Entregables (verificados en disco en este ciclo)

$ ls -la .pipeline/assets/mockups/6173/
6173-01-tarjeta-decision-dashboard.svg   14796 bytes  — 4 tipos de tarjeta del dashboard
6173-02-telegram-ficha-agrupada.svg      13632 bytes  — Telegram antes/despues
ux-criterios-6173.md                              — contrato de copy completo

$ validacion XML de los 2 SVG (parser de pila + chequeo de & crudo)
6173-01-tarjeta-decision-dashboard.svg  XML BIEN FORMADO  amp_crudo=0  balance=OK
6173-02-telegram-ficha-agrupada.svg     XML BIEN FORMADO  amp_crudo=0  balance=OK

Copy literal tambien publicado como comentario del issue (es el contrato que
verifica `validacion`): issuecomment-5343233526

Tokens: .pipeline/assets/design-tokens.css. Cero color nuevo, cero icono nuevo
(el sprite ya tiene ic-estado-needs-human, ic-estado-circuit-breaker,
ic-shield-lock, ic-conn-err, ic-expand/ic-collapse).

## Contenido del contrato de copy

- 7 plantillas literales `tipo -> ficha` con los 6 campos completos:
  dependencia, rebotes agotados (circuit), firma, infra, rebote, pregunta del
  agente, indeterminado. Incluye reglas de cuando marcar recomendada y con que
  razon.
- Glosario de traduccion interno -> operador (22 entradas) + mapa fase -> nombre
  legible.
- Lista negra de jerga con su limite exacto (no aplica al titulo citado).
- Tabla de redaccion de antiguedad con el "ahora" inyectado.
- Esqueleto de render de Telegram y arquitectura de la tarjeta del dashboard.

## Decisiones de UX que cierro yo

1. El tipo `firma` NUNCA lleva opcion recomendada (las 3 con es_recomendada:
   false + declaracion explicita "No hay recomendacion: la decision es tuya").
   Un gate que sugiere como firmar deja de ser gate. CA-A4 permite cero.
2. El tipo `pregunta del agente` tampoco: la pregunta es sobre el producto.
   Y la pregunta se cita LITERAL, nunca se parafrasea.
3. `consecuencia` en tercera persona describiendo que hace el sistema, no
   "Vas a...": la etiqueta ya es el verbo del operador.
4. La fila de 6 botones actual de la tarjeta se reordena: las opciones de la
   ficha reemplazan CTA y Destrabar; Desestimar queda arriba (es destructiva);
   Ver issue / Ver logs / Telegram bajan al detalle colapsado.

## Hallazgos verificados empiricamente (endurecen los criterios)

H-UX-1 — Los 5 textos `MOTIVOS[*].decision` del dashboard NO son preguntas
(ninguno termina en '?') y 3 de 5 traen jerga de la lista negra:
  [NO-PREGUNTA] Revisar el bucle de rebotes...            -> jerga: rebote
  [NO-PREGUNTA] Destrabar manualmente (override)...       -> jerga: override, dependencia
  [NO-PREGUNTA] Aprobar, reintentar o corregir...
  [NO-PREGUNTA] Definir criterios/alcance para que el pipeline... -> jerga: pipeline
  [NO-PREGUNTA] Responder la pregunta del agente...
La receta del architect dice que "migran tal cual". Migrarlos tal cual
incumple CA-C1 y CA-B2 a la vez. Reescritos en el contrato.

H-UX-2 — Salida REAL de buildBlockedSummaryPlain con 3 issues:
  📋 Incidentes bloqueados esperando humano (3)
  • #6173 — ux en criterios (3h)
     ↳ dependency_block: espera #6110
  • #6144 — po en criterios (30min)
     ↳ Confirmar alcance?
  • #6150 — guru en analisis (27h)

  Usá /unblock <issue> <orientación> para desbloquear.
Cuatro defectos en una salida: vocabulario de maquina ("ux en criterios"),
dato crudo sin traducir ("dependency_block: espera #6110"), #6150 llega SIN
NINGUNA RAZON (ficha vacia — el caso que CA-A5 obliga a declarar), y cero
consecuencias / cero costo de no decidir.

H-UX-3 — El pie es un molde: `<issue>` literal. Con 3 fichas agrupadas el
operador no sabe que numero poner. Cumplimiento de la decision 1 del PO: una
linea por ficha con numero real y valor de ejemplo
("Para decidir, respondé: /unblock 6173 esperar").

H-UX-4 — El test de CA-B2 se pone rojo por los TITULOS, no por el copy:
  $ gh issue list --state open --limit 200 --json number,title | grep -icE \
    "needs-human|blocked:dependencies|dispatch|worktree|allowlist|\.pipeline|pulpo\.js|barrido|ticks?|label|payload|dry-run|enforce|commit|HEAD"
  43        (de 200 -> 21,5%)
Ejemplos: #6178 "...del aviso de needs-human...", #6121 "Purgar los worktrees
residuales de .pipeline/_tmp", #6162 "...el 52% del gating del dispatch...".
Ajuste pedido: el guardian corre sobre los campos que la ficha REDACTA y
excluye `que_esta_frenado.titulo`, que se cita literal.

H-UX-5 — Las 4 `consequence` de ACTION_META no se reusan "tal cual":
  unblock              "Vas a desbloquear el issue y devolverlo a la cola del pipeline."
                       jerga: cola del pipeline | voz: 2a persona | razon_recomendacion: NO EXISTE
  mas-contexto         "Vas a pedir mas contexto; el issue queda bloqueado hasta que respondas."
  devolver-definicion  "Vas a devolver el issue a definicion. Se descarta el trabajo..."
  priorizar            "Vas a subir la prioridad de este issue y desbloquearlo."
Tres problemas: jerga en `unblock`, voz en 2a persona que choca con las
consecuencias nuevas (ficha con dos voces), y `razon_recomendacion` no existe
en ningun lugar del repo — hay que escribirla entera. Re-redaccion de las 4
incluida en el contrato.

## Ajustes pedidos sobre criterios (sin cambiar intencion)

1. CA-B2 / CA-F3: el guardian de jerga excluye el titulo citado (H-UX-4).
2. CA-A4: dejar explicito que CERO opciones recomendadas es valido y esperado
   en `firma` y `pregunta`, y que la ficha dice por que no hay recomendada.
3. CA-A3: "el gate retiene porque no hay firmante autorizado configurado" NO
   es ficha de `firma` sino `indeterminado` — pedir firmar cuando ninguna
   firma seria valida es una opcion inejecutable.
4. CA-A2: agregar cap de longitud por campo (220 chars; evidencia 120). Los
   mismos campos alimentan el guion de audio, con tope de 600.
5. CA-A5: el indeterminado debe cubrir tambien "el motivo llego vacio", que es
   el caso mas frecuente hoy (verificado en H-UX-2 con #6150).

Sin objeciones a CA-A1, CA-A6, CA-B1, CA-B3, CA-B4, CA-B5, CA-C1..C5,
CA-D1..D4, CA-E1..E4, CA-F1..F9 ni a las 5 decisiones de producto del PO.

## Recomendaciones pendientes de aprobacion humana

#6189 — [ux] Unificar la redaccion de antiguedad en una sola tabla: el
operador lee "52h" y tiene que dividir por 24. Verificado corriendo los 3
formateadores sobre los mismos valores:
  27 h -> dashboard: 27h   telegram: 27h   desync: hace 1 d 3 h
  52 h -> dashboard: 52h   telegram: 52h   desync: hace 2 d 4 h
No cree mas: las otras oportunidades ya estan cubiertas (#6175 colapsable,
#6174 emojis, #5922 y #6130 guideline de alertas, #6184 botones para todos los
tipos, #6185 medir tiempo hasta la decision).

## Nota de commit

No se commitea: el checkout esta parado en
agent/5863-destrabe-labels-y-fallback-commander (rama de otro agente, arbol
sucio con estado runtime del pipeline). Commitear ahi contaminaria trabajo
ajeno. Los assets quedan en .pipeline/assets/mockups/6173/ y el copy literal
viaja en el comentario del issue, que es el contrato que verifica `validacion`.
