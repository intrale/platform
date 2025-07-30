# Buscar negocios
Pertenece al módulo `users`.

Permite obtener sugerencias de negocios aprobados filtrando por texto.

```
POST /intrale/searchBusinesses
```

Cuerpo de la solicitud:
```json
{ "query": "caf" }
```

Respuesta:
```json
{ "businesses": ["cafe-roma", "cafeteria-centro"] }
```
