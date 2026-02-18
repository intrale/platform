#!/bin/bash
# Hook: reenvia notificaciones de Claude Code a Telegram

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
TITLE=$(echo "$INPUT" | grep -o '"title":"[^"]*"' | cut -d'"' -f4)
NOTIF_TYPE=$(echo "$INPUT" | grep -o '"notification_type":"[^"]*"' | cut -d'"' -f4)

BOT_TOKEN="8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk"
CHAT_ID="6529617704"

TEXT="[Claude Code] ${TITLE:-$NOTIF_TYPE}: ${MESSAGE}"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  > /dev/null 2>&1

exit 0
