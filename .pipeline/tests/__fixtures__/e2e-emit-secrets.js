// =============================================================================
// Fixture de E2E (#2334): lee secretos desde process.env y los emite por los
// distintos paths de write del pipeline que deberían sanitizar.
//
// Lo ejecuta `sanitize-e2e.test.js` como sub-proceso; NO es un test en sí.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname, '..', '..');
const sanitizerPath = path.join(PIPELINE, 'sanitizer.js');
const payloadPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js');
const logStreamPath = path.join(PIPELINE, 'lib', 'sanitize-log-stream.js');
const consolePath = path.join(PIPELINE, 'lib', 'sanitize-console.js');

const { sanitize } = require(sanitizerPath);
const { sanitizeTelegramPayload, sanitizeGithubPayload, sanitizeDrivePayload } = require(payloadPath);
const { createLogFileWriter } = require(logStreamPath);
require(consolePath).install();

const SANDBOX = process.env.TEST_SANDBOX;
const LOGS = path.join(SANDBOX, 'logs');
const REPORTS = path.join(SANDBOX, 'reports');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(REPORTS, { recursive: true });

// Secretos "cargados de config" — simula cómo un agente real lee
// credenciales de env/.secrets y después las menciona por error en logs.
const secrets = {
    aws: process.env.TEST_AWS,
    gh: process.env.TEST_GH,
    jwt: process.env.TEST_JWT,
    google: process.env.TEST_GOOGLE,
    googleRefresh: process.env.TEST_GOOGLE_REFRESH,
};

// ---------------------------------------------------------------------------
// Path 1: console.log post-install (svc-*, pulpo.log)
// ---------------------------------------------------------------------------
console.log('Iniciando agente con config:');
console.log('  aws_access_key_id=' + secrets.aws);
console.log('  github_token=' + secrets.gh);
console.log('  jwt=' + secrets.jwt);

// ---------------------------------------------------------------------------
// Path 2: writer de createLogFileWriter (agent log piped desde stdio)
// ---------------------------------------------------------------------------
const agentLog = path.join(LOGS, 'agent-2334-pipeline-dev.log');
const { writable, close } = createLogFileWriter(agentLog);
writable.write('--- agent start ---\n');
writable.write(`Fallo auth con token: ${secrets.jwt}\n`);
writable.write(`AWS key detectada: ${secrets.aws}\n`);
writable.write(`Google refresh: ${secrets.googleRefresh}\n`);

// ---------------------------------------------------------------------------
// Path 3: crash handler que invoca sanitize() directo
// ---------------------------------------------------------------------------
const crashMsg = sanitize(`[CRASH] uncaughtException: Error: auth fail ${secrets.aws}\n   at handler`);
fs.appendFileSync(path.join(LOGS, 'svc-telegram.log'), crashMsg);
fs.appendFileSync(path.join(LOGS, 'pulpo.log'), sanitize(`[CRASH] ${secrets.jwt}\n`));

// ---------------------------------------------------------------------------
// Path 4: sanitizeTelegramPayload → body serializado (simula API call)
// ---------------------------------------------------------------------------
const tgPayload = sanitizeTelegramPayload({
    text: `Rechazo #2334: token=${secrets.gh}. JWT=${secrets.jwt}`,
    parse_mode: 'Markdown',
});
const apiBody = JSON.stringify({ chat_id: -1, text: tgPayload.text });
fs.writeFileSync(path.join(REPORTS, 'telegram-api-body.json'), apiBody);

// ---------------------------------------------------------------------------
// Path 5: sanitizeGithubPayload → cmd serializado (simula execSync a gh)
// ---------------------------------------------------------------------------
const ghPayload = sanitizeGithubPayload({
    action: 'comment',
    issue: 2334,
    body: `Auth falló: token=${secrets.gh}. Ver ${secrets.aws}`,
});
const ghCmd = `gh issue comment ${ghPayload.issue} -b "${ghPayload.body.replace(/"/g, '\\"')}"`;
fs.writeFileSync(path.join(REPORTS, 'github-cmd.txt'), ghCmd);

// ---------------------------------------------------------------------------
// Path 6: sanitizeDrivePayload → args serializados
// ---------------------------------------------------------------------------
const drivePayload = sanitizeDrivePayload({
    file: 'qa/evidence/2334/qa.mp4',
    description: `#2334 — credenciales leaked: ${secrets.google}, ${secrets.jwt}`,
    title: `QA error ${secrets.aws}`,
});
fs.writeFileSync(
    path.join(REPORTS, 'drive-args.json'),
    JSON.stringify({
        file: drivePayload.file,
        description: drivePayload.description,
        title: drivePayload.title,
    }, null, 2),
);

// ---------------------------------------------------------------------------
// Cerramos streams para que el flush vaya a disco antes de exit.
// ---------------------------------------------------------------------------
close().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error('fixture close error:', e);
    process.exit(1);
});
