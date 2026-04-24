# Rol: Linter determinístico

**Este rol no lanza LLM.** Se ejecuta como script Node puro:
`.pipeline/skills-deterministicos/linter.js`.

## Fase: `linteo`

Corre entre `verificacion` y `aprobacion`. Consume **cero tokens**: sólo lee el
diff con `git` y aplica reglas mecánicas usando
`.pipeline/skills-deterministicos/lib/static-checks.js`.

## Chequeos

1. **Secretos hardcodeados** — AWS Access/Secret keys, GitHub PAT, OpenAI keys,
   Telegram bot tokens, claves privadas (PEM), asignaciones sospechosas a
   variables `*api_key*` / `*secret*` / `*password*`. Allowlist:
   `docs/`, `*.md`, `*.test.*`, `__tests__/`, `fixtures/`, `testdata/`,
   `*.example`, `*.sample`.
2. **Strings prohibidos en capa UI** (mismo criterio que el KSP
   `forbidden-strings-processor`): `stringResource(`, `Res.string.*`,
   `R.string.*`, `getString(`, `import kotlin.io.encoding.Base64`.
   Aplica sólo a `app/composeApp/src/**/*.kt`, excluyendo `ui/util/ResStrings`.
3. **Archivos sensibles** agregados al repo (`.env*`, `.pem`, `.p12`, `id_rsa`,
   `.keystore`, `credentials.*`, `application.conf`).
4. **Convención de rama** (`agent/<issue>-<slug>` o
   `feature|bugfix|docs|refactor|test|chore|fix/<slug>`). Rechaza `main` /
   `develop` / `HEAD`.
5. **Subjects de commits** (longitud ≤ 100 chars, sin puntuación final).
6. **Referencia `Closes #<issue>`** (o `Fixes` / `Resolves`) en algún commit.
7. **Tamaño del diff** — warning si > 1000 líneas cambiadas o > 40 archivos.

## Contrato con el Pulpo

- Marker en `trabajando/<issue>.linter` con `resultado`, `motivo`, contadores
  (`linter_errors`, `linter_warnings`, `linter_info`, `linter_total_findings`,
  `linter_duration_ms`, `linter_report_path`, `linter_mode: deterministic`).
- Heartbeat `agent-<issue>.heartbeat` cada 30s.
- Eventos V3 `session:start` / `session:end` en `traceability`.
- Exit **0** = aprobado (sólo warnings/info) → pasa a `aprobacion`.
- Exit **1** = findings de severidad `error` → rebote a `dev` **sin gastar
  tokens del reviewer**.
- Reporte persistido en `.pipeline/logs/lint-<issue>-report.md` y `.json` para
  que el `/review` LLM lo consuma como contexto en la fase siguiente.

## Operación manual

```
node .pipeline/skills-deterministicos/linter.js <issue> --trabajando=<path> --base=origin/main
```

## Tests

`node --test .pipeline/skills-deterministicos/__tests__/linter.test.js`
`node --test .pipeline/skills-deterministicos/__tests__/static-checks.test.js`
