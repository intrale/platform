#!/usr/bin/env node
// Script unificado: HTML -> PDF -> Telegram
// Uso: node scripts/report-to-pdf-telegram.js <html-content-or-file> [caption]
//
// Modos:
//   1. Archivo HTML existente:
//      node scripts/report-to-pdf-telegram.js docs/qa/reporte-sprint.html "Reporte Sprint"
//
//   2. HTML inline via stdin:
//      echo "<html>...</html>" | node scripts/report-to-pdf-telegram.js --stdin "Mi Reporte"
//
//   3. Markdown via stdin (se convierte a HTML):
//      echo "# Titulo" | node scripts/report-to-pdf-telegram.js --stdin --md "Mi Reporte"

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const DOCS_QA_DIR = path.join(__dirname, '..', 'docs', 'qa');
const TELEGRAM_CONFIG = path.join(__dirname, '..', '.claude', 'hooks', 'telegram-config.json');

// --- Args ---
const args = process.argv.slice(2);
const isStdin = args.includes('--stdin');
const isMd = args.includes('--md');
const filteredArgs = args.filter(a => a !== '--stdin' && a !== '--md');
const inputArg = filteredArgs[0];
const caption = filteredArgs[1] || filteredArgs[0] || 'Reporte Intrale';

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function markdownToHtml(md) {
  // Conversión básica de Markdown a HTML
  let html = md
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold + Italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Tables (basic)
    .replace(/^\|(.+)\|$/gm, (match) => {
      const cells = match.split('|').filter(c => c.trim());
      if (cells.every(c => /^[\s-:]+$/.test(c))) return ''; // separator row
      const tag = 'td';
      return '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    })
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    // Horizontal rules
    .replace(/^---+$/gm, '<hr>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newlines -> <br>
    .replace(/\n/g, '<br>');

  // Wrap lists
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Wrap tables
  html = html.replace(/(<tr>[\s\S]*?<\/tr>)/g, '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">$1</table>');
  html = html.replace(/<\/table>\s*<table[^>]*>/g, '');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; color: #333; line-height: 1.6; }
  h1 { color: #1a237e; border-bottom: 2px solid #1a237e; padding-bottom: 8px; }
  h2 { color: #283593; margin-top: 24px; }
  h3 { color: #3949ab; }
  table { width: 100%; margin: 16px 0; }
  th, td { padding: 8px 12px; text-align: left; border: 1px solid #ddd; }
  th { background: #e8eaf6; }
  tr:nth-child(even) { background: #f5f5f5; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #263238; color: #eee; padding: 16px; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; color: inherit; }
  li { margin: 4px 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 0.85em; color: #888; text-align: center; }
</style>
</head><body>
<p>${html}</p>
<div class="footer">Intrale Platform — Generado ${new Date().toISOString().slice(0, 10)}</div>
</body></html>`;
}

async function generatePdf(htmlPath) {
  const pdfPath = htmlPath.replace(/\.html$/, '.pdf');
  const reportName = path.basename(htmlPath, '.html');

  // Usar generate-pdf.js existente si está disponible
  const generatePdfScript = path.join(DOCS_QA_DIR, 'generate-pdf.js');
  if (fs.existsSync(generatePdfScript)) {
    console.log('Generando PDF con generate-pdf.js...');
    // Copiar HTML a docs/qa si no está ahí
    let targetHtml = htmlPath;
    if (!htmlPath.startsWith(DOCS_QA_DIR)) {
      targetHtml = path.join(DOCS_QA_DIR, path.basename(htmlPath));
      fs.copyFileSync(htmlPath, targetHtml);
    }
    execSync(`node "${generatePdfScript}" "${path.basename(targetHtml, '.html')}"`, {
      cwd: DOCS_QA_DIR,
      stdio: 'inherit',
      timeout: 120000
    });
    return path.join(DOCS_QA_DIR, path.basename(targetHtml, '.html') + '.pdf');
  }

  // Fallback: puppeteer directo
  const puppeteer = require(path.join(DOCS_QA_DIR, 'node_modules', 'puppeteer'));
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 60000 });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:8px; color:#999; width:100%; text-align:center; margin-top:5mm;">Intrale Platform — ${reportName}</div>`,
    footerTemplate: '<div style="font-size:8px; color:#999; width:100%; text-align:center; margin-bottom:5mm;">Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></div>'
  });
  await browser.close();
  console.log('PDF generado:', pdfPath);
  return pdfPath;
}

function sendToTelegram(pdfPath, caption) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(TELEGRAM_CONFIG)) {
      console.error('No se encontró telegram-config.json — PDF generado pero no enviado');
      resolve(false);
      return;
    }

    const config = JSON.parse(fs.readFileSync(TELEGRAM_CONFIG, 'utf8'));
    const pdfData = fs.readFileSync(pdfPath);
    const filename = path.basename(pdfPath);
    const boundary = 'boundary' + Date.now();

    let body = '';
    body += '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="chat_id"\r\n\r\n' + config.chat_id + '\r\n';
    body += '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n';
    body += '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="document"; filename="' + filename + '"\r\nContent-Type: application/pdf\r\n\r\n';
    const tail = '\r\n--' + boundary + '--\r\n';
    const bodyBuf = Buffer.concat([Buffer.from(body), pdfData, Buffer.from(tail)]);

    const options = {
      hostname: 'api.telegram.org',
      path: '/bot' + config.bot_token + '/sendDocument',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': bodyBuf.length }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.ok) {
            console.log('PDF enviado a Telegram OK');
            resolve(true);
          } else {
            console.error('Error Telegram:', data);
            resolve(false);
          }
        } catch (e) {
          console.error('Error parsing Telegram response:', e.message);
          resolve(false);
        }
      });
    });
    req.on('error', e => { console.error('Error de red Telegram:', e.message); resolve(false); });
    req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  let htmlPath;

  if (isStdin) {
    // Leer de stdin
    const content = await readStdin();
    if (!content.trim()) {
      console.error('Error: stdin vacío');
      process.exit(1);
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const slug = (caption || 'reporte').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `reporte-${slug}-${timestamp}`;

    let htmlContent;
    if (isMd) {
      htmlContent = markdownToHtml(content);
    } else {
      htmlContent = content;
    }

    htmlPath = path.join(DOCS_QA_DIR, filename + '.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf8');
    console.log('HTML guardado:', htmlPath);
  } else if (inputArg) {
    // Archivo existente
    htmlPath = path.resolve(inputArg);
    if (!fs.existsSync(htmlPath)) {
      console.error('Archivo no encontrado:', htmlPath);
      process.exit(1);
    }
  } else {
    console.error('Uso:');
    console.error('  node report-to-pdf-telegram.js <archivo.html> [caption]');
    console.error('  echo "<html>..." | node report-to-pdf-telegram.js --stdin [caption]');
    console.error('  echo "# Markdown" | node report-to-pdf-telegram.js --stdin --md [caption]');
    process.exit(1);
  }

  // Paso 1: generar PDF
  const pdfPath = await generatePdf(htmlPath);
  console.log('PDF listo:', pdfPath);

  // Paso 2: enviar a Telegram
  const sent = await sendToTelegram(pdfPath, caption);

  // Resumen
  console.log('\n--- Resumen ---');
  console.log('HTML:', htmlPath);
  console.log('PDF:', pdfPath);
  console.log('Telegram:', sent ? 'Enviado' : 'No enviado');

  if (!sent) process.exit(1);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
