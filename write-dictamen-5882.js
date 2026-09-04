const fs = require('fs');
const path = require('path');

const root = process.env.PIPELINE_REPO_ROOT || process.cwd();
const { writeDeliverable } = require(path.join(root, '.pipeline', 'lib', 'write-deliverable'));

const md = fs.readFileSync(path.join(__dirname, 'dictamen-5882.md'), 'utf8');

const result = writeDeliverable('architect', 5882, {
    fase: 'aprobacion',
    pipelineRoot: root,
    md,
});

console.log(JSON.stringify(result, null, 2));
