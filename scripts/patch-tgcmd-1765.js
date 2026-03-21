#!/usr/bin/env node
// Patch telegram-commander.js: add case "dash_section"
const fs = require('fs');
const path = require('path');

const tgSrc = path.join(__dirname, '..', '.claude', 'hooks', 'telegram-commander.js');
let tg = fs.readFileSync(tgSrc, 'utf8');

// Check if already patched
if (tg.includes('case "dash_section"')) {
    console.log('Already patched — skipping');
    process.exit(0);
}

// Use CRLF line endings to match the file
const CRLF = '\r\n';
const OLD_CASE =
    '                    case "reset_sprint":' + CRLF +
    '                        dispatcher.handleResetSprint(cmd.confirmed).catch(e => {' + CRLF +
    '                            log("Error en handleResetSprint: " + e.message);' + CRLF +
    '                            tgApi.sendMessage("\u274c Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});' + CRLF +
    '                        });' + CRLF +
    '                        break;' + CRLF +
    '                    case "unknown_command":';

const NEW_CASE =
    '                    case "reset_sprint":' + CRLF +
    '                        dispatcher.handleResetSprint(cmd.confirmed).catch(e => {' + CRLF +
    '                            log("Error en handleResetSprint: " + e.message);' + CRLF +
    '                            tgApi.sendMessage("\u274c Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});' + CRLF +
    '                        });' + CRLF +
    '                        break;' + CRLF +
    '                    case "dash_section":' + CRLF +
    '                        // Comandos /dash-* \u2014 screenshot de secci\u00f3n del dashboard (#1765)' + CRLF +
    '                        dispatcher.handleDashSection(cmd.section).catch(e => {' + CRLF +
    '                            log("Error en handleDashSection: " + e.message);' + CRLF +
    '                            tgApi.sendMessage("\u274c Error capturando secci\u00f3n: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});' + CRLF +
    '                        });' + CRLF +
    '                        break;' + CRLF +
    '                    case "unknown_command":';

if (!tg.includes(OLD_CASE)) {
    console.error('Target not found — trying without emoji');
    // Dump exact context
    const idx = tg.indexOf('case "reset_sprint"');
    if (idx !== -1) {
        const chunk = tg.substring(idx, idx + 400);
        console.log('Hex of relevant section:');
        for (let i = 0; i < chunk.length; i++) {
            process.stdout.write(chunk.charCodeAt(i).toString(16).padStart(2,'0') + ' ');
            if ((i+1) % 16 === 0) process.stdout.write('\n');
        }
        console.log('\n');
    }
    process.exit(1);
}

tg = tg.replace(OLD_CASE, NEW_CASE);
console.log('dash_section case added:', tg.includes('case "dash_section"'));
fs.writeFileSync(tgSrc, tg, 'utf8');
console.log('telegram-commander.js updated');
