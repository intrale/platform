# 20 – backlog-intake

Objetivo: permitir que leitocodexbot lea un bloque YAML en el body de un issue
("backlog intake") y cree múltiples issues nuevos a partir de cada ítem.

Formato esperado del YAML (en un bloque ```yaml``` del issue):

backlog_batch: "IDENTIFICADOR-LOQUESEA"
items:
- id: BAPP-001
  title: "Título de la historia"
  labels: ["stream:NEGOCIO", "app:business"]
  estimate: 3
  body: |
  Markdown con objetivo, contexto, criterios, etc.

Comportamiento:
- Por cada item:
    - Crear un issue nuevo en intrale/platform:
        - title: "{id} – {title}"
        - body: body (Markdown)
        - labels: las del YAML + "from-intake".
    - Si labels incluye "stream:CLIENTE" → Status: Backlog CLIENTE.
    - Si labels incluye "stream:NEGOCIO" → Status: Backlog NEGOCIO.
    - Si labels incluye "stream:DELIVERY" → Status: Backlog DELIVERY.
- Evitar duplicados: si ya existe un issue con ese título, no recrearlo.
- Publicar un comentario en el issue de intake con el listado de issues creados.

Activación:
- El usuario indicará "backlog intake en este issue" o comando equivalente,
  y el agente debe ejecutar el script de ingesta correspondiente.
