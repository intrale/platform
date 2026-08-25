'use strict';

const path = require('path');
const trace = require('./traceability');
const { readJsonSafe, writeJsonAtomic } = require('./atomic-json');
const DEFAULT_FILE = path.join(trace.REPO_ROOT, '.pipeline', 'audit', 'merge-race-reclaims.json');

function readLedger(file = DEFAULT_FILE) {
  const value = readJsonSafe(file, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function writeLedger(ledger, file = DEFAULT_FILE) {
  return writeJsonAtomic(file, ledger && typeof ledger === 'object' ? ledger : {}, { indent: 2 });
}
function getEntry(issue, file = DEFAULT_FILE) { return readLedger(file)[String(Number(issue))] || null; }
function recordAttempt({ issue, pr, head_sha, now = new Date(), file = DEFAULT_FILE }) {
  const ledger = readLedger(file); const key = String(Number(issue)); const previous = ledger[key];
  const samePair = previous && Number(previous.pr) === Number(pr) && String(previous.head_sha || '').toLowerCase() === String(head_sha || '').toLowerCase();
  ledger[key] = { pr: Number(pr), head_sha: String(head_sha || '').toLowerCase(), attempts: samePair ? Number(previous.attempts || 0) + 1 : 1, degraded: Boolean(samePair && previous.degraded === true), last_attempt_at: now.toISOString() };
  return writeLedger(ledger, file) ? ledger[key] : null;
}
function markDegraded({ issue, pr, head_sha, now = new Date(), file = DEFAULT_FILE }) {
  const ledger = readLedger(file); const key = String(Number(issue)); const previous = ledger[key] || {};
  ledger[key] = { pr: Number(pr), head_sha: String(head_sha || '').toLowerCase(), attempts: Number(previous.attempts || 0), degraded: true, last_attempt_at: now.toISOString() };
  return writeLedger(ledger, file);
}
function clearEntry(issue, file = DEFAULT_FILE) { const ledger = readLedger(file); delete ledger[String(Number(issue))]; return writeLedger(ledger, file); }
module.exports = { DEFAULT_FILE, readLedger, writeLedger, getEntry, recordAttempt, markDegraded, clearEntry };
