// test-p36-regression.js
// Tests para scripts/run-regression.js (#1806)
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var MOD_PATH = path.resolve(__dirname, "..", "..", "..", "scripts", "run-regression.js");
var mod = null;
try { mod = require(MOD_PATH); } catch (e) {}

function makeTempSuite(testCases) {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), "reg-test-"));
    var suitePath = path.join(d, "regression-suite.json");
    fs.writeFileSync(suitePath, JSON.stringify({ suite: "regression-test", test_cases: testCases || [] }));
    return { dir: d, suitePath: suitePath };
}

function makeTempRegressionDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "reg-dir-"));
}

test.describe("P-36.1: Estructura del modulo", function () {
    test.it("el archivo existe", function () {
        assert.ok(fs.existsSync(MOD_PATH), "No existe " + MOD_PATH);
    });
    test.it("exporta loadSuite", function () {
        assert.strictEqual(typeof mod.loadSuite, "function");
    });
    test.it("exporta runTestCase", function () {
        assert.strictEqual(typeof mod.runTestCase, "function");
    });
    test.it("exporta generateReport", function () {
        assert.strictEqual(typeof mod.generateReport, "function");
    });
    test.it("exporta loadRegressionReport", function () {
        assert.strictEqual(typeof mod.loadRegressionReport, "function");
    });
    test.it("exporta runRegressionSuite", function () {
        assert.strictEqual(typeof mod.runRegressionSuite, "function");
    });
    test.it("exporta SUITE_PATH como string", function () {
        assert.strictEqual(typeof mod.SUITE_PATH, "string");
    });
    test.it("exporta REGRESSION_DIR como string", function () {
        assert.strictEqual(typeof mod.REGRESSION_DIR, "string");
    });
});

test.describe("P-36.2: loadSuite valida", function () {
    test.it("retorna suite con test_cases", function () {
        var tc = [{ id: "REG-01", title: "Test", app: "client", flow: "login.yaml" }];
        var t = makeTempSuite(tc);
        var suite = mod.loadSuite(t.suitePath);
        assert.ok(suite !== null);
        assert.strictEqual(suite.test_cases.length, 1);
        fs.rmSync(t.dir, { recursive: true, force: true });
    });
    test.it("retorna null si no existe", function () {
        assert.strictEqual(mod.loadSuite("/tmp/no-existe-suite-xyz.json"), null);
    });
    test.it("retorna null si test_cases vacio", function () {
        var t = makeTempSuite([]);
        assert.strictEqual(mod.loadSuite(t.suitePath), null);
        fs.rmSync(t.dir, { recursive: true, force: true });
    });
    test.it("retorna null si JSON invalido", function () {
        var d = fs.mkdtempSync(path.join(os.tmpdir(), "reg-inv-"));
        var p = path.join(d, "bad.json");
        fs.writeFileSync(p, "not json {");
        assert.strictEqual(mod.loadSuite(p), null);
        fs.rmSync(d, { recursive: true, force: true });
    });
});

test.describe("P-36.3: runTestCase dry-run", function () {
    test.it("retorna skipped:true y passed:false", function () {
        var tc = { id: "REG-01", title: "Login", app: "business", flow: "login.yaml" };
        var r = mod.runTestCase(tc, { dryRun: true });
        assert.strictEqual(r.skipped, true);
        assert.strictEqual(r.passed, false);
        assert.strictEqual(r.error, null);
        assert.strictEqual(r.durationMs, 0);
    });
    test.it("dry-run no lanza excepcion con flow inexistente", function () {
        var tc = { id: "REG-XX", title: "No existe", app: "client", flow: "no-existe.yaml" };
        var r = mod.runTestCase(tc, { dryRun: true });
        assert.strictEqual(r.skipped, true);
    });
});

test.describe("P-36.4: runTestCase flow inexistente", function () {
    test.it("retorna skipped:true si flow no existe", function () {
        var tc = { id: "REG-99", title: "Inexistente", app: "client", flow: "no-existe-flow-xyz.yaml" };
        var r = mod.runTestCase(tc, { dryRun: false });
        assert.strictEqual(r.skipped, true);
        assert.strictEqual(r.passed, false);
        assert.ok(r.error && r.error.includes("no encontrado"));
    });
});

test.describe("P-36.5: generateReport", function () {
    test.it("genera JSON con summary correcto", function () {
        var suite = { suite: "regression-test" };
        var results = [
            { testCase: { id: "R1", title: "T1", app: "business", flow: "f1.yaml" }, result: { passed: true, skipped: false, error: null, durationMs: 1200 } },
            { testCase: { id: "R2", title: "T2", app: "client", flow: "f2.yaml" }, result: { passed: false, skipped: false, error: "FAIL", durationMs: 800 } },
            { testCase: { id: "R3", title: "T3", app: "client", flow: "f3.yaml" }, result: { passed: false, skipped: true, error: null, durationMs: 0 } }
        ];
        var regressionDir = makeTempRegressionDir();
        Object.defineProperty(mod, "REGRESSION_DIR", { value: regressionDir, configurable: true, writable: true });
        var res = mod.generateReport("SPR-TEST", results, suite);
        assert.strictEqual(res.report.summary.total, 3);
        assert.strictEqual(res.report.summary.passed, 1);
        assert.strictEqual(res.report.summary.failed, 1);
        assert.strictEqual(res.report.summary.skipped, 1);
        assert.ok(fs.existsSync(res.reportPath));
        fs.rmSync(regressionDir, { recursive: true, force: true });
    });
    test.it("passed es false si hay fallos", function () {
        var suite = { suite: "t" };
        var results = [{ testCase: { id: "R1", title: "T", app: "client", flow: "f.yaml" }, result: { passed: false, skipped: false, error: "e", durationMs: 0 } }];
        var regressionDir = makeTempRegressionDir();
        Object.defineProperty(mod, "REGRESSION_DIR", { value: regressionDir, configurable: true, writable: true });
        var res = mod.generateReport("SPR-A", results, suite);
        assert.strictEqual(res.report.passed, false);
        fs.rmSync(regressionDir, { recursive: true, force: true });
    });
    test.it("passed es true si todos pasaron", function () {
        var suite = { suite: "t" };
        var results = [{ testCase: { id: "R1", title: "T", app: "client", flow: "f.yaml" }, result: { passed: true, skipped: false, error: null, durationMs: 100 } }];
        var regressionDir = makeTempRegressionDir();
        Object.defineProperty(mod, "REGRESSION_DIR", { value: regressionDir, configurable: true, writable: true });
        var res = mod.generateReport("SPR-B", results, suite);
        assert.strictEqual(res.report.passed, true);
        fs.rmSync(regressionDir, { recursive: true, force: true });
    });
});

test.describe("P-36.6: loadRegressionReport", function () {
    test.it("retorna null si no existe", function () {
        assert.strictEqual(mod.loadRegressionReport("SPR-NOEXISTE-99999"), null);
    });
    test.it("retorna null para sprintId null", function () {
        assert.strictEqual(mod.loadRegressionReport(null), null);
    });
    test.it("carga el reporte si existe", function () {
        var suite = { suite: "t" };
        var results = [{ testCase: { id: "R1", title: "T", app: "client", flow: "f.yaml" }, result: { passed: true, skipped: false, error: null, durationMs: 500 } }];
        var regressionDir = makeTempRegressionDir();
        Object.defineProperty(mod, "REGRESSION_DIR", { value: regressionDir, configurable: true, writable: true });
        mod.generateReport("SPR-LOAD-TEST", results, suite);
        var loaded = mod.loadRegressionReport("SPR-LOAD-TEST");
        assert.ok(loaded !== null);
        assert.strictEqual(loaded.sprint_id, "SPR-LOAD-TEST");
        fs.rmSync(regressionDir, { recursive: true, force: true });
    });
});

test.describe("P-36.7: qa/regression-suite.json en el repo", function () {
    test.it("el archivo existe", function () {
        var repoRoot = path.resolve(__dirname, "..", "..", "..");
        var suitePath = path.join(repoRoot, "qa", "regression-suite.json");
        assert.ok(fs.existsSync(suitePath), "No existe " + suitePath);
    });
    test.it("tiene al menos 5 test cases", function () {
        var repoRoot = path.resolve(__dirname, "..", "..", "..");
        var suite = JSON.parse(fs.readFileSync(path.join(repoRoot, "qa", "regression-suite.json"), "utf8"));
        assert.ok(suite.test_cases.length >= 5, "Menos de 5: " + suite.test_cases.length);
    });
    test.it("todos tienen id title app y flow", function () {
        var repoRoot = path.resolve(__dirname, "..", "..", "..");
        var suite = JSON.parse(fs.readFileSync(path.join(repoRoot, "qa", "regression-suite.json"), "utf8"));
        suite.test_cases.forEach(function (tc) {
            assert.ok(tc.id); assert.ok(tc.title); assert.ok(tc.app); assert.ok(tc.flow);
        });
    });
    test.it("los IDs son unicos", function () {
        var repoRoot = path.resolve(__dirname, "..", "..", "..");
        var suite = JSON.parse(fs.readFileSync(path.join(repoRoot, "qa", "regression-suite.json"), "utf8"));
        var ids = suite.test_cases.map(function (tc) { return tc.id; });
        assert.strictEqual(new Set(ids).size, ids.length, "IDs duplicados");
    });
    test.it("apps validos: business client o delivery", function () {
        var repoRoot = path.resolve(__dirname, "..", "..", "..");
        var suite = JSON.parse(fs.readFileSync(path.join(repoRoot, "qa", "regression-suite.json"), "utf8"));
        var validApps = new Set(["business", "client", "delivery"]);
        suite.test_cases.forEach(function (tc) {
            assert.ok(validApps.has(tc.app), "app invalido: " + tc.app);
        });
    });
});
