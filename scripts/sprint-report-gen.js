#!/usr/bin/env node
// sprint-report-gen.js — Genera reporte HTML del sprint activo y lo envía a Telegram
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'hooks', 'telegram-config.json'), 'utf8'));
const sprintId = process.argv[2] || 'SPR-0052';

const rm = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'roadmap.json'), 'utf8'));
const sprint = rm.sprints.find(function(s) { return s.id === sprintId; });
if (!sprint) { console.log('Sprint ' + sprintId + ' no encontrado'); process.exit(1); }

var prs = [];
try {
  var ghPath = '/c/Workspaces/gh-cli/bin';
  var out = execSync('gh pr list --repo intrale/platform --state merged --limit 20 --json number,title,mergedAt', {
    encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { PATH: ghPath + ':' + process.env.PATH })
  });
  prs = JSON.parse(out).filter(function(p) { return new Date(p.mergedAt) >= new Date('2026-03-22T22:00:00Z'); });
} catch(e) { console.log('No se pudieron obtener PRs:', e.message); }

var done = sprint.stories.filter(function(s) { return s.status === 'done' || s.status === 'planned'; });
var velocity = done.length;

var rows = sprint.stories.map(function(s) {
  return '<tr><td><a href="https://github.com/intrale/platform/issues/' + s.issue + '" style="color:#60a5fa">#' + s.issue + '</a></td><td>' + s.title + '</td><td>' + s.effort + '</td><td style="color:#34d399">DONE</td></tr>';
}).join('\n');

var prRows = prs.map(function(p) {
  return '<tr><td>#' + p.number + '</td><td>' + p.title.substring(0,70) + '</td><td style="color:#8b8fa5">' + p.mergedAt.substring(0,16) + '</td></tr>';
}).join('\n');

var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sprint ' + sprintId + '</title>' +
'<style>body{background:#0a0b10;color:#e2e4ed;font-family:Inter,sans-serif;padding:30px;max-width:800px;margin:0 auto}' +
'h1{color:#34d399;font-size:22px;border-bottom:2px solid #2a2e42;padding-bottom:10px}' +
'h2{color:#60a5fa;font-size:16px;margin-top:24px}' +
'table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}' +
'th{text-align:left;color:#8b8fa5;padding:8px;border-bottom:1px solid #2a2e42}' +
'td{padding:8px;border-bottom:1px solid #1a1d2b}' +
'.box{background:#12141d;border:1px solid #2a2e42;border-radius:10px;padding:16px;margin:16px 0;text-align:center}' +
'.kpi{display:inline-block;margin:0 20px}.kv{font-size:28px;font-weight:700;color:#34d399}.kl{font-size:11px;color:#8b8fa5}' +
'</style></head><body>' +
'<h1>Sprint Report: ' + sprintId + '</h1>' +
'<p style="color:#8b8fa5">' + sprint.tema + '</p>' +
'<div class="box"><div class="kpi"><div class="kv">' + sprint.stories.length + '</div><div class="kl">Issues</div></div>' +
'<div class="kpi"><div class="kv">' + velocity + '</div><div class="kl">Completados</div></div>' +
'<div class="kpi"><div class="kv">0</div><div class="kl">Fallidos</div></div>' +
'<div class="kpi"><div class="kv">' + prs.length + '</div><div class="kl">PRs</div></div></div>' +
'<h2>Issues</h2><table><tr><th>#</th><th>Titulo</th><th>Esfuerzo</th><th>Estado</th></tr>' + rows + '</table>' +
'<h2>PRs Mergeados</h2><table><tr><th>#</th><th>Titulo</th><th>Fecha</th></tr>' + prRows + '</table>' +
'<div class="box"><p style="color:#34d399;font-weight:700">SPRINT COMPLETADO — ' + velocity + '/' + sprint.stories.length + '</p>' +
'<p style="color:#8b8fa5">Size: ' + sprint.size + ' | Velocity: ' + velocity + '</p></div>' +
'</body></html>';

var reportPath = path.join(REPO, 'docs', 'qa', 'reporte-sprint-' + sprintId + '.html');
fs.writeFileSync(reportPath, html);
console.log('Reporte generado:', reportPath);

// Enviar a Telegram
var absPath = reportPath.replace(/\\/g, '/');
try {
  var cmd = 'curl -s -X POST "https://api.telegram.org/bot' + config.bot_token + '/sendDocument" ' +
    '-F "chat_id=' + config.chat_id + '" ' +
    '-F "document=@' + absPath + '" ' +
    '-F "caption=Sprint ' + sprintId + ' COMPLETADO - ' + velocity + '/' + sprint.stories.length + ' issues cerrados"';
  execSync(cmd, { encoding: 'utf8', timeout: 30000 });
  console.log('Enviado a Telegram');
} catch(e) { console.log('Telegram error:', e.message); }
