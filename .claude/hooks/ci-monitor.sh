#!/bin/bash
# Script: El Vigía — monitorea CI en GitHub Actions y notifica por Telegram
# Uso: ci-monitor.sh <SHA> [PROJECT_DIR]
# Corre en background (lanzado por post-git-push.sh)

SHA="$1"
PROJECT_DIR="${2:-/c/Workspaces/Intrale/platform}"

if [ -z "$SHA" ]; then
    exit 1
fi

REPO="intrale/platform"
BOT_TOKEN="8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk"
CHAT_ID="6529617704"
MAX_WAIT=1800   # 30 minutos máximo
INTERVAL=30     # Poll cada 30 segundos
ELAPSED=0

# Obtener token de GitHub via credential helper
TOKEN=$(git -C "$PROJECT_DIR" credential fill <<< $'protocol=https\nhost=github.com' 2>/dev/null | grep password | cut -d= -f2)
if [ -z "$TOKEN" ]; then
    exit 1
fi

# Notificar inicio de monitoreo
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=[El Vigía] 🔭 Monitoreando CI para commit ${SHA:0:7}..." \
  > /dev/null 2>&1

# Esperar a que CI arranque
sleep 45

# Polling hasta que todos los checks terminen
while [ $ELAPSED -lt $MAX_WAIT ]; do
    RESPONSE=$(curl -s -H "Authorization: token $TOKEN" \
        "https://api.github.com/repos/$REPO/commits/$SHA/check-runs")

    TOTAL=$(echo "$RESPONSE" | grep -o '"total_count":[0-9]*' | head -1 | cut -d: -f2)

    if [ "${TOTAL:-0}" -gt 0 ]; then
        IN_PROGRESS=$(echo "$RESPONSE" | grep -o '"status":"in_progress"' | wc -l | tr -d ' ')
        QUEUED=$(echo "$RESPONSE" | grep -o '"status":"queued"' | wc -l | tr -d ' ')

        if [ "$IN_PROGRESS" -eq 0 ] && [ "$QUEUED" -eq 0 ]; then
            # CI terminó — evaluar resultado
            FAILURES=$(echo "$RESPONSE" | grep -o '"conclusion":"failure"' | wc -l | tr -d ' ')
            CANCELLED=$(echo "$RESPONSE" | grep -o '"conclusion":"cancelled"' | wc -l | tr -d ' ')
            SUCCESS=$(echo "$RESPONSE" | grep -o '"conclusion":"success"' | wc -l | tr -d ' ')

            if [ "$FAILURES" -gt 0 ]; then
                MSG="[El Vigía] ❌ CI FALLÓ — $FAILURES checks fallidos | commit ${SHA:0:7}"
            elif [ "$CANCELLED" -gt 0 ]; then
                MSG="[El Vigía] ⚠️ CI cancelado | commit ${SHA:0:7}"
            else
                MSG="[El Vigía] ✅ CI OK — $SUCCESS checks pasados | commit ${SHA:0:7}"
            fi

            curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
              --data-urlencode "chat_id=${CHAT_ID}" \
              --data-urlencode "text=${MSG}" \
              > /dev/null 2>&1

            exit 0
        fi
    fi

    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

# Timeout alcanzado
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=[El Vigía] ⏱️ Timeout esperando CI para commit ${SHA:0:7} (30 min)" \
  > /dev/null 2>&1

exit 0
