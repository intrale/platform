const target = process.argv[2];
const VARS = ['PULPO_NO_AUTOSTART', 'PULPO_SKIP_AGENT_MODELS_VALIDATE',
              'PULPO_SKIP_DATA_RESIDENCY_VALIDATE', 'PIPELINE_STALENESS_HOURS',
              'PIPELINE_ROOT_OVERRIDE', 'PIPELINE_DIR_OVERRIDE', 'NODE_PATH'];
const realReallyExit = process.reallyExit.bind(process);
let reported = false;
const report = () => {
    if (reported) return; reported = true;
    const leak = VARS.filter(v => v in process.env).map(v => `${v} (len ${String(process.env[v]).length})`);
    console.error('LEAK>>', leak.length ? leak.join(' | ') : '(ninguna)');
};
process.reallyExit = (c) => { report(); realReallyExit(c); };
require(target);
process.on('exit', report);
