#!/usr/bin/env node
// Smoke test: verify all #1765 features are present in the patched files
const fs = require('fs');
const path = require('path');
const WT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function check(desc, ok) {
    if (ok) { pass++; console.log("  ✓ " + desc); }
    else    { fail++; console.log("  ✗ " + desc); }
}

// ── dashboard-server.js ──
const ds = fs.readFileSync(path.join(WT, '.claude', 'dashboard-server.js'), 'utf8');
console.log("\n=== dashboard-server.js ===");
check("renderHTML accepts section param", ds.includes("function renderHTML(data, theme, section)"));
check("section filter JS in HTML", ds.includes("data-panel") && ds.includes("sec === \"overview\""));
check("renderLogsHTML function exists", ds.includes("function renderLogsHTML("));
check("/overview route", ds.includes("pathname === '/overview'"));
check("/flow route", ds.includes("pathname === '/flow'"));
check("/activity route", ds.includes("pathname === '/activity'"));
check("/roadmap route", ds.includes("pathname === '/roadmap'"));
check("/cicd route", ds.includes("pathname === '/cicd'"));
check("/logs route", ds.includes("pathname === \"/logs\"") || ds.includes("pathname === '/logs'"));
check("/api/logs endpoint", ds.includes("/api/logs"));
check("screenshot route param", ds.includes("routeParam") && ds.includes("targetPath"));
check("takeScreenshot uses targetPath", ds.includes("opts.targetPath"));

// ── command-dispatcher.js ──
const cd = fs.readFileSync(path.join(WT, '.claude', 'hooks', 'commander', 'command-dispatcher.js'), 'utf8');
console.log("\n=== command-dispatcher.js ===");
check("/dash-* parse in parseCommand", cd.includes('startsWith("/dash-")'));
check("dash_section type returned", cd.includes('type: "dash_section"'));
check("handleDashSection function", cd.includes("async function handleDashSection(section)"));
check("handleDashSection exported", cd.includes("handleDashSection,"));
check("screenshot via http.get", cd.includes("/screenshot?route="));

// ── telegram-commander.js ──
const tc = fs.readFileSync(path.join(WT, '.claude', 'hooks', 'telegram-commander.js'), 'utf8');
console.log("\n=== telegram-commander.js ===");
check("case dash_section in switch", tc.includes('case "dash_section"'));
check("calls dispatcher.handleDashSection", tc.includes("dispatcher.handleDashSection(cmd.section)"));

console.log("\n" + "=".repeat(40));
console.log("RESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
