// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../scripts/opstate-cutover-probe');
const infra = require('../lib/provisioner-infra');
const { createFakeSyncDynamoDriver } = require('../lib/__tests__/fixtures/fake-sync-dynamo-driver');

for (const source of ['otro-principal', 'runtime-principal', 'perfil']) {
    const principal = source === 'perfil' ? 'runtime-principal' : source;
    test(`SEC-2: perfil runtime y origen ${source}, identidad ligada al escritor y readback`, async (t) => {
        const fakeDriver = createFakeSyncDynamoDriver();
        fakeDriver.kind = 'aws-cli-sync';
        let writerEnv;
        let stsEnv;
        let readbackEnv;
        let writes = 0;
        const put = fakeDriver.putItem;
        fakeDriver.putItem = (...args) => { writes++; return put(...args); };
        t.mock.method(infra, 'createAwsCliRunnerSync', (env) => {
            writerEnv = env;
            return { runSync() { throw new Error('red no permitida'); } };
        });
        t.mock.method(infra, 'createAwsCliDynamoDriverSync', () => fakeDriver);
        const out = await probe.run(['--cas-probe', '--json'], {
            config: { kernel: { runtimePrincipal: 'runtime-principal', runtimeProfile: 'runtime-profile', coordinationTableName: 'fake-table', region: 'us-east-1' } },
            projectId: 'fake-project',
            env: source === 'perfil' ? {} : { AWS_ACCESS_KEY_ID: 'fake-id', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-session', AWS_PROFILE: 'runtime-profile' },
            credsDeps: { spawnSync(command, args) {
                assert.equal(command, 'aws');
                assert.ok(args.includes('runtime-profile'));
                return { status: 0, stdout: 'fake-profile-value' };
            } },
            spawnSync(command, args, options) {
                assert.equal(command, 'aws');
                if (args[0] === 'sts') {
                    stsEnv = options.env;
                    // Reproduce la precedencia de AWS CLI: --profile sustituye las claves de env.
                    const actual = args.includes('--profile') ? 'runtime-principal' : principal;
                    return { status: 0, stdout: JSON.stringify({ Arn: `arn:aws:iam::<ACCT>:user/${actual}` }) };
                }
                assert.equal(args[0], 'dynamodb');
                assert.ok(!args.includes('--profile'));
                readbackEnv = options.env;
                const item = fakeDriver._raw('fake-project', `coord#${probe.PROBE_KEY}`);
                return { status: 0, stdout: JSON.stringify({ Item: infra.toAttrValues(item) }) };
            },
        });
        console.log(JSON.stringify({ source, principal, exitCode: out.exitCode, writes, writerFromEnv: !!writerEnv, mismoEntorno: !!writerEnv && writerEnv === stsEnv && stsEnv === readbackEnv }));
        if (principal === 'otro-principal') {
            assert.equal(out.exitCode, 1);
            assert.equal(out.result.checks[0].causa, 'identidad_inesperada');
            assert.equal(writes, 0);
            assert.equal(writerEnv, undefined);
            assert.equal(readbackEnv, undefined);
        } else {
            assert.equal(out.exitCode, 0, out.text);
            assert.equal(writes, 1);
            assert.strictEqual(writerEnv, stsEnv);
            assert.strictEqual(readbackEnv, stsEnv);
            if (source !== 'perfil') assert.equal(writerEnv.AWS_SESSION_TOKEN, 'fake-session');
        }
    });
}
