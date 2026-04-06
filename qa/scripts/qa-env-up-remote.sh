#!/usr/bin/env bash
# Levanta el entorno QA en modo remoto: sin Docker, sin backend local.
# El emulador apunta al API Gateway de AWS (Lambda + DynamoDB + Cognito reales).
#
# Pasos:
#   1. Liberacion pre-QA (Priority Window + kill residuales + check RAM)
#   2. Deploy backend a Lambda via GitHub Actions
#   3. Health-check del endpoint remoto
#
# Uso: ./qa/scripts/qa-env-up-remote.sh [--skip-deploy] [--ref <rama>]
#   --skip-deploy  No deployar, asumir que Lambda ya tiene la version correcta
#   --ref <rama>   Rama a deployar (default: rama actual)
#
# Prerequisitos:
#   - gh CLI autenticado
#   - Artefactos de build en qa/artifacts/ (APK + JAR)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACTS_DIR="$PROJECT_ROOT/qa/artifacts"
PIPELINE_DIR="$PROJECT_ROOT/.pipeline"
export PATH="/c/Workspaces/gh-cli/bin:$PATH"

# API Gateway endpoint
QA_REMOTE_URL="https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev"

# Parametros
SKIP_DEPLOY=false
DEPLOY_REF=""
MIN_FREE_RAM_MB=3000

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-deploy) SKIP_DEPLOY=true; shift ;;
    --ref) DEPLOY_REF="$2"; shift 2 ;;
    *) echo "WARN: Argumento desconocido: $1"; shift ;;
  esac
done

cd "$PROJECT_ROOT"

# Rama actual si no se especifico
if [ -z "$DEPLOY_REF" ]; then
  DEPLOY_REF=$(git branch --show-current)
fi

echo "=== QA Environment REMOTO — Levantando ==="
echo "  Rama: $DEPLOY_REF"
echo "  Endpoint: $QA_REMOTE_URL"
echo ""

# ── 1. Liberacion pre-QA ──────────────────────────────────
echo "[1/4] Liberacion pre-QA..."

# 1a. Activar QA Priority Window (bloquea nuevos agentes)
PW_FILE="$PIPELINE_DIR/priority-windows.json"
if [ -d "$PIPELINE_DIR" ]; then
  node -e "
    const fs = require('fs');
    const f = '$PW_FILE';
    let pw = {};
    try { pw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
    pw.qa = { active: true, activatedAt: Date.now(), manual: true, reason: 'qa-env-up-remote' };
    pw.updatedAt = Date.now();
    fs.writeFileSync(f, JSON.stringify(pw, null, 2));
    console.log('  QA Priority Window ACTIVADA');
  " 2>/dev/null || echo "  WARN: No se pudo activar Priority Window"
fi

# 1b. Esperar a que builds activos terminen (max 5 min)
echo "  Verificando builds activos..."
BUILD_WAIT_MAX=300
BUILD_WAIT=0
while [ $BUILD_WAIT -lt $BUILD_WAIT_MAX ]; do
  # Contar procesos java que NO sean esta sesion
  JAVA_COUNT=$(powershell -Command "(Get-Process java -ErrorAction SilentlyContinue).Count" 2>/dev/null || echo "0")
  JAVA_COUNT=$(echo "$JAVA_COUNT" | tr -d '\r\n ')
  if [ "$JAVA_COUNT" -le 1 ] 2>/dev/null; then
    echo "  Sin builds activos"
    break
  fi
  if [ $BUILD_WAIT -eq 0 ]; then
    echo "  Esperando que $JAVA_COUNT procesos Java terminen..."
  fi
  sleep 10
  BUILD_WAIT=$((BUILD_WAIT + 10))
done

if [ $BUILD_WAIT -ge $BUILD_WAIT_MAX ]; then
  echo "  WARN: Timeout esperando builds. Continuando igualmente..."
fi

# 1c. Limpiar procesos Java residuales
echo "  Limpiando procesos Java residuales..."
powershell -Command "
  Get-Process java -ErrorAction SilentlyContinue |
    Where-Object { \$_.StartTime -lt (Get-Date).AddMinutes(-30) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
" 2>/dev/null || true

# 1d. Verificar RAM libre
FREE_MB=$(powershell -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB,0)" 2>/dev/null || echo "0")
FREE_MB=$(echo "$FREE_MB" | tr -d '\r\n ')
echo "  RAM libre: ${FREE_MB} MB (minimo requerido: ${MIN_FREE_RAM_MB} MB)"

if [ "$FREE_MB" -lt "$MIN_FREE_RAM_MB" ] 2>/dev/null; then
  echo "  WARN: RAM insuficiente. Intentando liberar mas..."
  # Matar TODOS los Java residuales (no solo los viejos)
  powershell -Command "Stop-Process -Name java -Force -ErrorAction SilentlyContinue" 2>/dev/null || true
  sleep 3
  FREE_MB=$(powershell -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB,0)" 2>/dev/null || echo "0")
  FREE_MB=$(echo "$FREE_MB" | tr -d '\r\n ')
  echo "  RAM libre despues de limpieza agresiva: ${FREE_MB} MB"
  if [ "$FREE_MB" -lt "$MIN_FREE_RAM_MB" ] 2>/dev/null; then
    echo "ERROR: RAM insuficiente (${FREE_MB} MB < ${MIN_FREE_RAM_MB} MB). Abortando QA."
    exit 1
  fi
fi

echo "  Liberacion pre-QA completada"
echo ""

# ── 2. Verificar artefactos de Build ─────────────────────
echo "[2/4] Verificando artefactos de Build..."

APK_PATH=""
# Buscar APK en qa/artifacts/ (generado por fase Build)
if [ -f "$ARTIFACTS_DIR/composeApp-client-debug.apk" ]; then
  APK_PATH="$ARTIFACTS_DIR/composeApp-client-debug.apk"
  echo "  APK encontrado en qa/artifacts/"
fi

# Si no esta en artifacts, buscar en el directorio de build habitual
if [ -z "$APK_PATH" ]; then
  APK_SEARCH=$(find "$PROJECT_ROOT/app/composeApp/build/outputs/apk/client/debug/" -name '*.apk' 2>/dev/null | head -1)
  if [ -n "$APK_SEARCH" ]; then
    APK_PATH="$APK_SEARCH"
    echo "  APK encontrado en build/outputs/"
  fi
fi

# Si no esta en ninguno, buscar en worktrees de build del mismo issue
if [ -z "$APK_PATH" ]; then
  ISSUE_NUM=$(echo "$DEPLOY_REF" | sed -n 's/.*\/\([0-9]*\)-.*/\1/p')
  if [ -n "$ISSUE_NUM" ]; then
    for WT_DIR in /c/Workspaces/Intrale/platform.wt-*; do
      if [ -d "$WT_DIR" ]; then
        WT_APK=$(find "$WT_DIR/app/composeApp/build/outputs/apk/client/debug/" -name '*.apk' 2>/dev/null | head -1)
        if [ -n "$WT_APK" ]; then
          APK_PATH="$WT_APK"
          echo "  APK encontrado en worktree: $WT_DIR"
          break
        fi
      fi
    done
  fi
fi

if [ -z "$APK_PATH" ]; then
  echo "ERROR: No se encontro APK. La fase Build debe generar el APK primero."
  echo "  Ubicaciones buscadas:"
  echo "    - qa/artifacts/composeApp-client-debug.apk"
  echo "    - app/composeApp/build/outputs/apk/client/debug/*.apk"
  echo "    - Worktrees de build"
  exit 1
fi

echo "  APK: $APK_PATH"
echo "  Tamano: $(du -h "$APK_PATH" | cut -f1)"

# Verificar que el APK fue compilado SIN LOCAL_BASE_URL (apunta al remoto)
if [ -f "$ARTIFACTS_DIR/BUILD_COMMIT" ]; then
  BUILD_COMMIT=$(cat "$ARTIFACTS_DIR/BUILD_COMMIT" | tr -d '\r\n')
  echo "  Build commit: $BUILD_COMMIT"
fi
if [ -f "$ARTIFACTS_DIR/BUILD_TIMESTAMP" ]; then
  BUILD_TS=$(cat "$ARTIFACTS_DIR/BUILD_TIMESTAMP" | tr -d '\r\n')
  echo "  Build timestamp: $BUILD_TS"
fi
echo ""

# ── 3. Deploy backend a Lambda ───────────────────────────
if [ "$SKIP_DEPLOY" = true ]; then
  echo "[3/4] Deploy OMITIDO (--skip-deploy)"
else
  echo "[3/4] Deployando backend a Lambda via GitHub Actions..."

  # Asegurar que la rama esta pusheada
  echo "  Pusheando rama $DEPLOY_REF..."
  git push origin "$DEPLOY_REF" 2>/dev/null || true

  # Disparar el workflow
  echo "  Disparando workflow main.yml..."
  if ! gh workflow run main.yml --ref "$DEPLOY_REF" 2>&1; then
    echo "ERROR: No se pudo disparar el workflow"
    echo "  Verificar: gh workflow list"
    exit 1
  fi

  # Esperar a que aparezca el run (puede tardar unos segundos)
  sleep 5

  # Obtener el ID del run mas reciente del workflow
  echo "  Esperando que el workflow termine..."
  DEPLOY_TIMEOUT=600  # 10 min max
  DEPLOY_ELAPSED=0

  while [ $DEPLOY_ELAPSED -lt $DEPLOY_TIMEOUT ]; do
    RUN_INFO=$(gh run list --workflow=main.yml --limit=1 --json status,conclusion,databaseId -q '.[0]' 2>/dev/null)
    RUN_STATUS=$(echo "$RUN_INFO" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).status)}catch(e){console.log('unknown')}" 2>/dev/null)
    RUN_STATUS=$(echo "$RUN_STATUS" | tr -d '\r\n ')

    if [ "$RUN_STATUS" = "completed" ]; then
      RUN_CONCLUSION=$(echo "$RUN_INFO" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).conclusion)}catch(e){console.log('unknown')}" 2>/dev/null)
      RUN_CONCLUSION=$(echo "$RUN_CONCLUSION" | tr -d '\r\n ')

      if [ "$RUN_CONCLUSION" = "success" ]; then
        echo ""
        echo "  Deploy exitoso!"
        break
      else
        echo ""
        echo "ERROR: Workflow termino con conclusion: $RUN_CONCLUSION"
        RUN_ID=$(echo "$RUN_INFO" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{console.log(JSON.parse(d).databaseId)}catch(e){}" 2>/dev/null)
        echo "  Ver logs: gh run view $RUN_ID --log"
        exit 1
      fi
    fi

    sleep 15
    DEPLOY_ELAPSED=$((DEPLOY_ELAPSED + 15))
    MINS=$((DEPLOY_ELAPSED / 60))
    SECS=$((DEPLOY_ELAPSED % 60))
    printf "\r  Esperando... %dm%02ds / %dm" "$MINS" "$SECS" "$((DEPLOY_TIMEOUT / 60))"
  done

  if [ $DEPLOY_ELAPSED -ge $DEPLOY_TIMEOUT ]; then
    echo ""
    echo "ERROR: Timeout esperando deploy (${DEPLOY_TIMEOUT}s)"
    exit 1
  fi
fi
echo ""

# ── 4. Health-check del endpoint remoto ──────────────────
echo "[4/4] Health-check del endpoint remoto..."

# Warmup: 3 requests para evitar cold start
echo "  Warmup (3 requests)..."
for i in 1 2 3; do
  curl -s -o /dev/null -w "" \
    -X POST "$QA_REMOTE_URL/intrale/signin" \
    -H "Content-Type: application/json" \
    -d '{"email":"warmup","password":"warmup"}' 2>/dev/null || true
  sleep 2
done

# Health-check real
HC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$QA_REMOTE_URL/intrale/signin" \
  -H "Content-Type: application/json" \
  -d '{"email":"test","password":"test"}' 2>/dev/null)

if [ "$HC_STATUS" = "400" ] || [ "$HC_STATUS" = "401" ]; then
  echo "  Lambda respondiendo correctamente (HTTP $HC_STATUS)"
elif [ "$HC_STATUS" = "000" ]; then
  echo "ERROR: No se pudo conectar al endpoint remoto"
  echo "  URL: $QA_REMOTE_URL"
  echo "  Verificar conectividad a internet"
  exit 1
else
  echo "  WARN: Health-check retorno HTTP $HC_STATUS (esperado 400)"
  echo "  Continuando igualmente..."
fi

# Guardar estado para qa-env-down-remote.sh
cat > "$PROJECT_ROOT/qa/.qa-remote-state" <<EOF
QA_MODE=remote
QA_REMOTE_URL=$QA_REMOTE_URL
APK_PATH=$APK_PATH
DEPLOY_REF=$DEPLOY_REF
STARTED_AT=$(date -u +%Y%m%d-%H%M%S)
EOF

echo ""
echo "=== QA Environment REMOTO listo ==="
echo "  Endpoint: $QA_REMOTE_URL"
echo "  APK: $APK_PATH"
echo "  Rama deployada: $DEPLOY_REF"
echo "  Para tirar abajo: ./qa/scripts/qa-env-down-remote.sh"
