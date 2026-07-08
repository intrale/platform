## Reporte de auditoría de seguridad — issue #4566

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/4566-pipeline-dev`, commit `40d51ca56`, diff vs `origin/main`:
- `.pipeline/lib/gh-title-fetch.js` (nuevo — clasificación pura 404 genuino / transitorio)
- `.pipeline/dashboard.js` — `fetchIssueTitles` (~L281-354) y `fetchIssueTitlesAsync` (~L364-406)
- `.pipeline/lib/title-cache-freshness.js` — negative-cache TTL
- `.pipeline/tests/gh-title-cache-poison-4566.test.js` — 23 tests, todos PASS

### Hallazgos

**Sin hallazgos.** El cambio es una corrección de robustez sobre herramienta interna
del pipeline (dashboard Node.js); no introduce vulnerabilidades explotables.

Ejes OWASP evaluados:

- **A03 Inyección — CWE-78 (command injection):** SIN riesgo nuevo. La única
  superficie es `${id}` interpolado en `gh issue view ${id}` (fallback shell,
  `dashboard.js`) y en la query GraphQL. Ambos paths conservan intacto el guard
  SEC-1 (#4096): `safeIds = issueIds.filter(id => /^\d+$/.test(String(id)))` en
  `dashboard.js:290-292` (sync) y `dashboard.js:366-367` (async), aplicado ANTES
  de cualquier `execSync`/`exec`. Un id no numérico (p.ej. `"4096; rm -rf .build"`)
  se descarta antes de tocar el shell. El fix no altera ese filtro.
  - **Vector (criollo):** para meter un comando, un atacante tendría que colar un
    "número de issue" con caracteres de shell; el filtro numérico lo tira antes.
- **A02 Exposición de datos sensibles:** sin secrets/tokens/passwords en el diff;
  solo procesa título, labels y state (datos públicos) del propio repo.
- **A07 Fallas de auth:** no aplica — sin JWT/Cognito, sin endpoints,
  sin `SecuredFunction`. Herramienta interna desatendida.
- **ReDoS:** `NOT_FOUND_RE` y `TRANSIENT_RE` (`gh-title-fetch.js:26-28`) son
  alternaciones simples, sin cuantificadores anidados ni backtracking catastrófico.
- **DoS / abuso de estado:** el `negativeTtlMs` (24h) auto-cura envenenamientos sin
  martillar `gh`; `transientError` reintenta acotado por el flujo de refetch. No
  abre amplificación de requests.

### Remediación

No requerida. El fix, además, elimina un modo de fallo operacional (negative-cache
permanente que clavaba la métrica de avance) sin abrir superficie de seguridad nueva.
