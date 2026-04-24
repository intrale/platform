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
  openai: 'Hola Leito, soy Claudito hablando con OpenAI TTS. Esta es la voz premium que usamos por defecto. Si la escuchás bien, queda como primary.',
  edge:   'Eeeeh Leo, todo bien. Soy Tommy, el pibe nuevo del equipo. Estoy probando la voz de Edge TTS desde es-AR Tomas Neural. Si te cierra como fallback la banco yo cuando Claudito se tome licencia.'
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
