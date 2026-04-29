// =============================================================================
// Cert self-signed para tests TLS (CA-7). Válido solo para localhost/127.0.0.1
// y con expiración a 100 años para evitar flakiness. NO usar en producción.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEST_SELF_SIGNED_CERT = fs.readFileSync(path.join(__dirname, 'tls-test.crt'), 'utf8');
const TEST_SELF_SIGNED_KEY = fs.readFileSync(path.join(__dirname, 'tls-test.key'), 'utf8');

module.exports = { TEST_SELF_SIGNED_CERT, TEST_SELF_SIGNED_KEY };
