# UX · criterios #7633: export de la cadena de autoría

Complementa las pautas U1-U6 de #7593 y el mockup `../7593/export-autoria-referencia.html`.
Estos dos mockups **mandan en copy** cuando difieren del de #7593 (la estructura, el CSS y la CSP son idénticos):

- `export-autoria-pr.html`: export de un PR (1 commit, firmado).
- `export-autoria-rango.html`: rango mixto de 5 commits, "1 de 5 cambios con firma", una tarjeta por estado.

## Ajustes al mockup de #7593 (por D-A2: sólo trailer en main + GitHub)

1. **Cadena de 4 eslabones derivables del trailer:** tarea (Intrale-Issue + título) → IA (Intrale-AI-Assisted) → firma (Intrale-Human-Direction) → sellado (sha + fecha del commit + PR). El de #7593 mostraba gate1 **y** gate2 a la vez, pero el trailer lleva **una** decisión.
2. **No se nombra el "libro de aprobaciones"** como fuente: la fila "Cómo se registró la decisión" dice "Firma del operador, anclada en el registro del cambio en la rama principal".
3. **La leyenda literal** (CA-2/SE) va primera en "Qué prueba y qué no", en un callout ámbar: *"Esta constancia verifica la consistencia de los registros en `main`; no prueba por sí sola la autenticidad de la firma."*
4. **Sin "Página N" fijo en el footer HTML**: el número de página lo pone el `footerTemplate` del PDF.
5. **"X de N cambios con firma"** en negrita y como primera frase del resumen, y también como primer KPI. En el export de un PR también aparece ("1 de 1" / "0 de 1").

## Copy de estados (tarjeta: badge con ícono + texto, fila "Por qué" nunca vacía)

| Estado | Badge | "Quién dirigió" | "Por qué" | Suma a X |
|---|---|---|---|---|
| signed | `✔ Dirección humana firmada` (verde) | `<login> (operador)` | (sin fila) | sí |
| unsigned · dry-run | `⚠ Sin firma registrada` (ámbar) | Sin firma registrada | Se integró mientras la verificación estaba en modo de prueba. | no |
| unsigned · pre-go-live | `⚠ Sin firma registrada` (ámbar) | Sin firma registrada | Cambio anterior a la entrada en vigencia del registro de firma (dd/mm/aaaa). | no |
| unsigned · valor fuera de allowlist | `⚠ Sin firma registrada` (ámbar) | Sin firma registrada | El dato de firma de este cambio no tiene un formato reconocido; por seguridad no se muestra. | no |
| invalid | `✖ Trailer inválido` (rojo) | No se puede afirmar | Los datos de autoría de este cambio están repetidos o fuera de lugar, así que no se toman como firma y el cambio no suma al conteo. | no |

Recomendación para `labels-es.js`: sumar un motivo `unrecognized` a `UNSIGNED_REASONS`, además de `dry-run` y `pre-go-live`, para que la tercera fila ámbar no quede sin texto.

## Caso "0 de N" (D-0/N)

Si X = 0 y todos los motivos son dry-run o pre-go-live, se agrega al resumen esta frase: "Ningún cambio de este alcance tiene firma registrada. Es lo esperado mientras la verificación de firma funciona en modo de prueba; no indica un error del documento." Así el primer PDF real no parece un bug para quien lo recibe.

## Accesibilidad y print

- Contrastes AA sobre blanco, heredados del mockup de #7593. El estado nunca se comunica sólo con color: siempre hay ícono y texto.
- Tarjetas con `break-inside: avoid`. A4, tema claro.
- Las notas del mockup (`.no-print`, entre corchetes) **no** van en el export real.

## Validación en aprobación

Por el PASO 2-bis: se compara el export del fixture de rango mixto lado a lado con `export-autoria-rango.html`, y el export de un PR real con `export-autoria-pr.html`, que en la realidad va a dar "0 de 1" con su motivo.
