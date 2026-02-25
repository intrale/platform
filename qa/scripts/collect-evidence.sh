#!/usr/bin/env bash
# Recolecta evidencias QA E2E y las persiste en qa/evidence/{timestamp}/.
# Uso: bash qa/scripts/collect-evidence.sh [--dry-run]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

EVIDENCE_BASE="$PROJECT_ROOT/qa/evidence"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
DEST="$EVIDENCE_BASE/$TIMESTAMP"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] Solo se mostrara que se haria, sin copiar archivos."
fi

# ── Helpers ──────────────────────────────────────────────────

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -e "$src" ]; then
    if $DRY_RUN; then
      echo "  [dry-run] cp -r $src -> $dst"
    else
      mkdir -p "$(dirname "$dst")"
      cp -r "$src" "$dst"
    fi
    return 0
  fi
  return 1
}

copy_glob() {
  local src_dir="$1"
  local pattern="$2"
  local dst_dir="$3"
  local found=false

  if [ -d "$src_dir" ]; then
    for f in "$src_dir"/$pattern; do
      [ -e "$f" ] || continue
      found=true
      if $DRY_RUN; then
        echo "  [dry-run] cp $f -> $dst_dir/"
      else
        mkdir -p "$dst_dir"
        cp "$f" "$dst_dir/"
      fi
    done
  fi

  if $found; then return 0; else return 1; fi
}

# ── Recoleccion ──────────────────────────────────────────────

echo "=== Recolectando evidencias QA E2E ==="
echo "  Destino: $DEST"
echo ""

COLLECTED=false

# --- API: reportes HTML + JUnit XML ---
echo "[api] Buscando reportes de tests API..."
API_REPORTS="$PROJECT_ROOT/qa/build/reports/tests/test"
API_RESULTS="$PROJECT_ROOT/qa/build/test-results/test"

if [ -d "$API_REPORTS" ]; then
  echo "  Encontrado: $API_REPORTS"
  if copy_if_exists "$API_REPORTS" "$DEST/api/html"; then
    COLLECTED=true
  fi
fi

if [ -d "$API_RESULTS" ]; then
  echo "  Encontrado: $API_RESULTS"
  if copy_glob "$API_RESULTS" "*.xml" "$DEST/api/junit"; then
    COLLECTED=true
  fi
fi

# --- API: traces Playwright (.zip) ---
RECORDINGS="$PROJECT_ROOT/qa/recordings"
echo "[api] Buscando traces Playwright..."
if copy_glob "$RECORDINGS" "*.zip" "$DEST/api/traces"; then
  echo "  Traces copiados"
  COLLECTED=true
else
  echo "  No se encontraron traces (.zip)"
fi

# --- API: screenshots (.png) ---
echo "[api] Buscando screenshots..."
if copy_glob "$RECORDINGS" "*.png" "$DEST/api/screenshots"; then
  echo "  Screenshots copiados"
  COLLECTED=true
else
  echo "  No se encontraron screenshots (.png)"
fi

# --- Desktop: reportes desktopTest ---
echo "[desktop] Buscando reportes de tests Desktop..."
DESKTOP_REPORTS="$PROJECT_ROOT/app/composeApp/build/reports/tests/desktopTest"

if [ -d "$DESKTOP_REPORTS" ]; then
  echo "  Encontrado: $DESKTOP_REPORTS"
  if copy_if_exists "$DESKTOP_REPORTS" "$DEST/desktop/html"; then
    COLLECTED=true
  fi
else
  echo "  No se encontraron reportes Desktop"
fi

# --- Android: Maestro results ---
echo "[android] Buscando resultados Maestro..."
if copy_glob "$RECORDINGS" "maestro-results.xml" "$DEST/android"; then
  echo "  maestro-results.xml copiado"
  COLLECTED=true
else
  echo "  No se encontro maestro-results.xml"
fi

if copy_glob "$RECORDINGS" "maestro-output.log" "$DEST/android"; then
  echo "  maestro-output.log copiado"
fi

# ── Verificar que se recolecto algo ──────────────────────────

if ! $COLLECTED; then
  echo ""
  echo "WARN: No se encontraron evidencias para recolectar."
  echo "  Asegurate de haber corrido los tests antes (ej: /qa api)."
  exit 0
fi

# ── Generar summary.md ───────────────────────────────────────

echo ""
echo "[summary] Generando summary.md..."

if $DRY_RUN; then
  echo "  [dry-run] Generaria summary.md en $DEST/summary.md"
else
  SUMMARY="$DEST/summary.md"
  cat > "$SUMMARY" <<HEADER
# Evidencias QA E2E — $TIMESTAMP

| Nivel | Tests | Passed | Failed | Skipped |
|-------|-------|--------|--------|---------|
HEADER

  # Parsear JUnit XML para cada nivel
  for level_dir in api desktop android; do
    JUNIT_DIR="$DEST/$level_dir/junit"
    [ -d "$JUNIT_DIR" ] || continue

    TOTAL=0
    PASSED=0
    FAILURES=0
    SKIPPED=0

    for xml in "$JUNIT_DIR"/*.xml; do
      [ -e "$xml" ] || continue
      # Extraer atributos del tag <testsuite>
      T=$(sed -n 's/.*tests="\([0-9]*\)".*/\1/p' "$xml" | head -1)
      F=$(sed -n 's/.*failures="\([0-9]*\)".*/\1/p' "$xml" | head -1)
      S=$(sed -n 's/.*skipped="\([0-9]*\)".*/\1/p' "$xml" | head -1)
      E=$(sed -n 's/.*errors="\([0-9]*\)".*/\1/p' "$xml" | head -1)

      TOTAL=$((TOTAL + ${T:-0}))
      FAILURES=$((FAILURES + ${F:-0} + ${E:-0}))
      SKIPPED=$((SKIPPED + ${S:-0}))
    done

    PASSED=$((TOTAL - FAILURES - SKIPPED))
    if [ $PASSED -lt 0 ]; then PASSED=0; fi

    echo "| $level_dir | $TOTAL | $PASSED | $FAILURES | $SKIPPED |" >> "$SUMMARY"
  done

  # Si hay reporte HTML sin JUnit (desktop), registrar solo presencia
  if [ -d "$DEST/desktop/html" ] && [ ! -d "$DEST/desktop/junit" ]; then
    echo "| desktop | - | - | - | - |" >> "$SUMMARY"
  fi

  echo "" >> "$SUMMARY"
  echo "Generado por \`qa/scripts/collect-evidence.sh\`" >> "$SUMMARY"
  echo "  summary.md generado"
fi

# ── Actualizar latest/ ───────────────────────────────────────

echo ""
echo "[latest] Actualizando qa/evidence/latest/..."

if $DRY_RUN; then
  echo "  [dry-run] Reemplazaria $EVIDENCE_BASE/latest/ con contenido de $DEST/"
else
  rm -rf "$EVIDENCE_BASE/latest"
  cp -r "$DEST" "$EVIDENCE_BASE/latest"
  echo "  latest/ actualizado"
fi

# ── Fin ──────────────────────────────────────────────────────

echo ""
echo "=== Evidencias recolectadas en $DEST ==="
echo "  Ver reporte: qa/evidence/latest/api/html/index.html"
echo "  Ver resumen: qa/evidence/latest/summary.md"
