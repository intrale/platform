#!/bin/bash
# Smoke test: verifica que redactUrlLike NO filtra el BOT_TOKEN de Telegram
# (fix del rebote de security del 2026-04-20 — CA-11.1 / #2332)

cd /c/Workspaces/Intrale/platform.agent-2332-android-dev

echo "=== Test 1: URL de Telegram con BOT_TOKEN redactada ==="
node -e "const {redactUrlLike}=require('./.pipeline/lib/redact.js'); \
  const url='https://api.telegram.org/bot1234567890:ABCDefGHIjklMNOpqrsTUVwxyz/sendMessage'; \
  const out=redactUrlLike(url); \
  console.log('INPUT : '+url); \
  console.log('OUTPUT: '+out); \
  if (out.includes('ABCDefGHIjklMNOpqrsTUVwxyz')) { console.error('FAIL: token en claro'); process.exit(1); } \
  if (!out.includes('[REDACTED]')) { console.error('FAIL: no marker'); process.exit(1); } \
  console.log('PASS: token redactado, marker presente');"
echo ""

echo "=== Test 2: /bot/list (falso positivo corto) no redacta ==="
node -e "const {redactUrlLike}=require('./.pipeline/lib/redact.js'); \
  const url='https://api.intrale.com/bot/list'; \
  const out=redactUrlLike(url); \
  console.log('INPUT : '+url); \
  console.log('OUTPUT: '+out); \
  if (out.includes('[REDACTED]')) { console.error('FAIL: redacto legitimo'); process.exit(1); } \
  console.log('PASS: /bot/list preservado');"
echo ""

echo "=== Test 3: tokens en múltiples posiciones + query ==="
node -e "const {redactUrlLike}=require('./.pipeline/lib/redact.js'); \
  const url='https://api.telegram.org/bot9876543210:XYZ_TOKEN_MUY_LARGO_DE_EJEMPLO/getUpdates?access_token=SECRET123'; \
  const out=redactUrlLike(url); \
  console.log('INPUT : '+url); \
  console.log('OUTPUT: '+out); \
  if (out.includes('XYZ_TOKEN_MUY_LARGO') || out.includes('SECRET123')) { console.error('FAIL'); process.exit(1); } \
  console.log('PASS: path+query ambos redactados');"
