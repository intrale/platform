// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// Fixtures de commits para el export de autoría (#7633). Los bloques se arman
// con `buildTrailerBlock` / `formatHumanDirection` reales (#7631), así el fixture
// "firmado" es exactamente lo que escribe delivery.

const { buildTrailerBlock, formatHumanDirection } = require('../../trailer');

const HASH = 'ab12cd34ef56' + '0'.repeat(52);
const GO_LIVE = '2026-09-20T00:00:00Z';

function sha(ch) {
    return ch.repeat(40);
}

const signedBlock = buildTrailerBlock({
    issue: 7593,
    humanLine: formatHumanDirection({ ok: true, login: 'leitolarreta', ts: '2026-09-23T19:12:00Z', kind: 'gate2', hash: HASH }),
    aiLine: 'anthropic/claude-opus-5-5 (backend-dev), openai/gpt-5-codex (review)',
    coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>'],
});

const noneBlock = buildTrailerBlock({
    issue: 7631,
    humanLine: formatHumanDirection({ ok: false, reason: 'missing', ts: '2026-09-24T13:23:02Z' }),
    aiLine: 'anthropic/claude-opus-4-7 (pipeline-dev)',
});

const SIGNED = {
    sha: sha('9'),
    date: '2026-09-23T16:15:00-03:00',
    message: `Trazabilidad de autoría (#7650)\n\nDetalle del cambio.\n\n${signedBlock}\n`,
};

const NONE_MISSING = {
    sha: sha('d'),
    date: '2026-09-24T10:23:02-03:00',
    message: `Trailer de autoría (#7651)\n\n- cambio\n\n${noneBlock}\n`,
};

const NO_BLOCK_POST = {
    sha: sha('4'),
    date: '2026-09-21T11:03:10-03:00',
    message: 'Ajuste menor (#7612)\n\nSin bloque de autoría.\n',
};

const NO_BLOCK_PRE = {
    sha: sha('7'),
    date: '2026-09-12T15:40:55-03:00',
    message: 'Cambio viejo (#7388)\n\nAnterior a la vigencia.\n',
};

const DUPLICATE = {
    sha: sha('c'),
    date: '2026-09-22T10:00:00-03:00',
    message: [
        'Clave duplicada (#7640)',
        '',
        'Closes #7622',
        'Intrale-Issue: #7622',
        'Intrale-Human-Direction: leitolarreta; 2026-09-22T12:00:00Z; gate2:sha256:' + HASH,
        'Intrale-Human-Direction: otro; 2026-09-22T12:00:00Z; gate2:sha256:' + HASH,
        'Intrale-AI-Assisted: unknown',
    ].join('\n'),
};

const OUT_OF_BLOCK = {
    sha: sha('e'),
    date: '2026-09-22T10:00:00-03:00',
    message: [
        'Clave fuera del bloque (#7641)',
        '',
        'Intrale-Human-Direction: leitolarreta; 2026-09-22T12:00:00Z; gate2:sha256:' + HASH,
        '',
        'Closes #7622',
        'Intrale-Issue: #7622',
        'Intrale-Human-Direction: none; 2026-09-22T12:00:00Z; missing',
        'Intrale-AI-Assisted: unknown',
    ].join('\n'),
};

const OUT_OF_ALLOWLIST = {
    sha: sha('2'),
    date: '2026-09-22T11:00:00-03:00',
    message: [
        'Valor fuera de formato (#7645)',
        '',
        'Closes #7630',
        'Intrale-Issue: #7630',
        'Intrale-Human-Direction: <script>alert(1)</script>; C:\\Users\\x; ghp_abc123',
        'Intrale-AI-Assisted: unknown',
    ].join('\n'),
};

const MIXED_RANGE = [SIGNED, NO_BLOCK_POST, NO_BLOCK_PRE, DUPLICATE, OUT_OF_ALLOWLIST];

module.exports = {
    HASH,
    GO_LIVE,
    SIGNED,
    NONE_MISSING,
    NO_BLOCK_POST,
    NO_BLOCK_PRE,
    DUPLICATE,
    OUT_OF_BLOCK,
    OUT_OF_ALLOWLIST,
    MIXED_RANGE,
};
