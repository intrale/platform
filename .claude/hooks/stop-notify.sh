#!/bin/bash
# Hook Stop: notifica a Telegram cuando Claude termina su respuesta

INPUT=$(cat)

BOT_TOKEN="8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk"
CHAT_ID="6529617704"

TEXT="[Claude Code] ✅ Listo — esperando tu siguiente instrucción"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  > /dev/null 2>&1

exit 0
