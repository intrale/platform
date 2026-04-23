#!/usr/bin/env node
// Script de prueba: genera audio con OpenAI TTS y Edge TTS y los manda a Telegram
// Uso:  node .pipeline/scripts/test-tts-dual.js

const path = require('path');
const fs = require('fs');
const { textToSpeechOpenAI, textToSpeechEdge, sendVoiceTelegram } = require(path.resolve(__dirname, '..', 'multimedia.js'));

const ROOT = path.resolve(__dirname, '..', '..');
const TG_CONFIG_PATH = path.join(ROOT, '.claude', 'hooks', 'telegram-config.json');
const tg = JSON.parse(fs.readFileSync(TG_CONFIG_PATH, 'utf8'));

const TEXTS = {
  openai: 'Hola Leito, soy el Commander hablando con OpenAI TTS. Esta es la voz premium que usamos por defecto. Si la escuchás bien, queda como primary.',
  edge:   'Hola Leito, ahora probando Edge TTS, voz es-AR Tomas. Este es el fallback gratis. Si la calidad te cierra, podés switchearlo como primary cuando quieras.'
};

(async () => {
  console.log('=== Test TTS dual: OpenAI + Edge ===');

  console.log('\n[1/2] Generando con OpenAI...');
  const openaiBuf = await textToSpeechOpenAI(TEXTS.openai);
  if (openaiBuf) {
    console.log(`  OpenAI OK: ${openaiBuf.length} bytes — enviando a Telegram...`);
    const ok = await sendVoiceTelegram(openaiBuf, tg.bot_token, tg.chat_id);
    console.log(`  Telegram sendVoice(openai): ${ok}`);
  } else {
    console.log('  OpenAI FALLÓ (null). No envío.');
  }

  console.log('\n[2/2] Generando con Edge...');
  const edgeBuf = await textToSpeechEdge(TEXTS.edge);
  if (edgeBuf) {
    console.log(`  Edge OK: ${edgeBuf.length} bytes — enviando a Telegram...`);
    const ok = await sendVoiceTelegram(edgeBuf, tg.bot_token, tg.chat_id);
    console.log(`  Telegram sendVoice(edge): ${ok}`);
  } else {
    console.log('  Edge FALLÓ (null). No envío.');
  }

  console.log('\n=== Done ===');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
