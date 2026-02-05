# ✅ Evidencia de verificación (obligatoria)

Reglas duras:
- Prohibido omitir tests: no usar `-x test`, `--exclude-task test`, ni desactivar pruebas.
- No declarar Ready/Terminado sin tests OK + evidencia en issue.
- Si no puedes ejecutar/verificar tests: detener trabajo, marcar Blocked y explicar faltantes.

Template comentario (copiar/pegar):
✅ Verification Evidence
PR: <link>
Commit: <sha>
Gradle verification:
Command(s): <comando exacto>
Result: ✅ (<resumen>)
CI:
Workflow/Run: <link> ✅
Notes: <opcional>

Si falla:
❌ Verification Failed
PR: <link>
Commit: <sha>
Failed step: <comando/check>
Error summary: <10-20 líneas>
Next action: <fix en progreso/cause>
