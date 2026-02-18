#!/bin/bash
# Script: El Vigia -- monitorea CI en GitHub Actions y notifica por Telegram
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
MAX_WAIT=1800   # 30 minutos maximo
INTERVAL=30     # Poll cada 30 segundos
ELAPSED=0

# Obtener token de GitHub via credential helper
TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git -C "$PROJECT_DIR" credential fill 2>/dev/null | grep password | cut -d= -f2)
if [ -z "$TOKEN" ]; then
    exit 1
fi

# Notificar inicio de monitoreo
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=[El Vigia] Monitoreando CI para commit ${SHA:0:7}..." \
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
            # CI termino -- evaluar resultado
            FAILURES=$(echo "$RESPONSE" | grep -o '"conclusion":"failure"' | wc -l | tr -d ' ')
            CANCELLED=$(echo "$RESPONSE" | grep -o '"conclusion":"cancelled"' | wc -l | tr -d ' ')
            SUCCESS=$(echo "$RESPONSE" | grep -o '"conclusion":"success"' | wc -l | tr -d ' ')

            if [ "$FAILURES" -gt 0 ]; then
                MSG="[El Vigia] FALLO CI -- $FAILURES checks fallidos | commit ${SHA:0:7}"
            elif [ "$CANCELLED" -gt 0 ]; then
                MSG="[El Vigia] CI cancelado | commit ${SHA:0:7}"
            else
                MSG="[El Vigia] CI OK -- $SUCCESS checks pasados | commit ${SHA:0:7}"
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
  --data-urlencode "text=[El Vigia] Timeout esperando CI para commit ${SHA:0:7} (30 min)" \
  > /dev/null 2>&1

exit 0
