// test-p18-smart-permissions.js — Tests para sistema de permisos inteligente (#1223)
// Cubre: splitCompoundCommand, isSafeDirectory, isReversibleAction, classifySeverity

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Mock CLAUDE_PROJECT_DIR para tests
const TEST_REPO_ROOT = "/c/Workspaces/Intrale/platform";
process.env.CLAUDE_PROJECT_DIR = TEST_REPO_ROOT;

const {
    splitCompoundCommand,
    isSafeDirectory,
    isReversibleAction,
    classifySeverity,
    Severity,
    extractFirstCommand,
    DESTRUCTIVE_PATTERNS
} = require("../permission-utils");

// ─── splitCompoundCommand ─────────────────────────────────────────────────

describe("splitCompoundCommand", () => {
    it("caso basico con && separa correctamente", () => {
        const result = splitCompoundCommand("export A=1 && git status | head -5");
        assert.deepStrictEqual(result, ["export A=1", "git status", "head -5"]);
    });

    it("comando simple sin separadores retorna array de 1", () => {
        const result = splitCompoundCommand("git status");
        assert.deepStrictEqual(result, ["git status"]);
    });

    it("respeta comillas dobles — no separa && dentro de comillas", () => {
        const result = splitCompoundCommand('echo "hello && world" && git status');
        assert.deepStrictEqual(result, ['echo "hello && world"', "git status"]);
    });

    it("respeta comillas simples", () => {
        const result = splitCompoundCommand("echo 'foo | bar' | head -1");
        assert.deepStrictEqual(result, ["echo 'foo | bar'", "head -1"]);
    });

    it("maneja subshell $() correctamente", () => {
        const result = splitCompoundCommand("echo $(git status && echo done) | head");
        assert.deepStrictEqual(result, ["echo $(git status && echo done)", "head"]);
    });

    it("diferencia pipe | de OR ||", () => {
        const result = splitCompoundCommand("git pull || echo 'fail' | head");
        assert.deepStrictEqual(result, ["git pull", "echo 'fail'", "head"]);
    });

    it("maneja redirecciones 2>&1 sin separar", () => {
        const result = splitCompoundCommand("./gradlew build 2>&1 | tail -50");
        assert.deepStrictEqual(result, ["./gradlew build 2>&1", "tail -50"]);
    });

    it("maneja redireccion a archivo >/dev/null", () => {
        const result = splitCompoundCommand("echo test > /dev/null && git status");
        assert.deepStrictEqual(result, ["echo test > /dev/null", "git status"]);
    });

    it("comando con ; como separador", () => {
        const result = splitCompoundCommand("cd /path ; make ; echo done");
        assert.deepStrictEqual(result, ["cd /path", "make", "echo done"]);
    });

    it("export JAVA_HOME con && y pipe", () => {
        const result = splitCompoundCommand('export JAVA_HOME="/c/path" && ./gradlew build --info 2>&1 | tail -50');
        assert.deepStrictEqual(result, ['export JAVA_HOME="/c/path"', "./gradlew build --info 2>&1", "tail -50"]);
    });

    it("retorna array vacio para string vacio", () => {
        assert.deepStrictEqual(splitCompoundCommand(""), []);
        assert.deepStrictEqual(splitCompoundCommand(null), []);
        assert.deepStrictEqual(splitCompoundCommand(undefined), []);
    });

    it("maneja parentesis anidados", () => {
        const result = splitCompoundCommand("(echo a && echo b) && echo c");
        assert.deepStrictEqual(result, ["(echo a && echo b)", "echo c"]);
    });
});

// ─── isSafeDirectory ──────────────────────────────────────────────────────

describe("isSafeDirectory", () => {
    it("archivo en .claude/ es seguro", () => {
        assert.ok(isSafeDirectory(TEST_REPO_ROOT + "/.claude/hooks/test.js", TEST_REPO_ROOT));
    });

    it("archivo en qa/ es seguro", () => {
        assert.ok(isSafeDirectory(TEST_REPO_ROOT + "/qa/evidence/1220/screenshot.png", TEST_REPO_ROOT));
    });

    it("archivo en docs/ es seguro", () => {
        assert.ok(isSafeDirectory(TEST_REPO_ROOT + "/docs/arquitectura-app.md", TEST_REPO_ROOT));
    });

    it("archivo en backend/ NO es seguro", () => {
        assert.ok(!isSafeDirectory(TEST_REPO_ROOT + "/backend/src/Main.kt", TEST_REPO_ROOT));
    });

    it("archivo en app/ NO es seguro", () => {
        assert.ok(!isSafeDirectory(TEST_REPO_ROOT + "/app/composeApp/src/Main.kt", TEST_REPO_ROOT));
    });

    it("path con backslashes se normaliza", () => {
        assert.ok(isSafeDirectory(TEST_REPO_ROOT.replace(/\//g, "\\") + "\\.claude\\hooks\\test.js", TEST_REPO_ROOT));
    });

    it("retorna false para null/undefined", () => {
        assert.ok(!isSafeDirectory(null, TEST_REPO_ROOT));
        assert.ok(!isSafeDirectory("", TEST_REPO_ROOT));
    });
});

// ─── isReversibleAction ─────────────────────────────────────────────────────

describe("isReversibleAction", () => {
    it("Edit sobre .claude/ es reversible", () => {
        assert.ok(isReversibleAction("Edit", { file_path: TEST_REPO_ROOT + "/.claude/hooks/test.js" }, TEST_REPO_ROOT));
    });

    it("Write sobre qa/ es reversible", () => {
        assert.ok(isReversibleAction("Write", { file_path: TEST_REPO_ROOT + "/qa/evidence/test.png" }, TEST_REPO_ROOT));
    });

    it("Edit sobre backend/ NO es reversible (fuera de safe dir)", () => {
        assert.ok(!isReversibleAction("Edit", { file_path: TEST_REPO_ROOT + "/backend/src/Main.kt" }, TEST_REPO_ROOT));
    });

    it("Bash sin comandos destructivos es reversible", () => {
        assert.ok(isReversibleAction("Bash", { command: "git status && echo done" }, TEST_REPO_ROOT));
    });

    it("Bash con rm -rf NO es reversible", () => {
        assert.ok(!isReversibleAction("Bash", { command: "rm -rf /c/Workspaces" }, TEST_REPO_ROOT));
    });

    it("Bash con git push --force NO es reversible", () => {
        assert.ok(!isReversibleAction("Bash", { command: "git push --force origin main" }, TEST_REPO_ROOT));
    });

    it("WebFetch es reversible", () => {
        assert.ok(isReversibleAction("WebFetch", { url: "https://example.com" }, TEST_REPO_ROOT));
    });
});

// ─── classifySeverity ───────────────────────────────────────────────────────

describe("classifySeverity", () => {
    it("TaskCreate es AUTO_ALLOW", () => {
        assert.strictEqual(classifySeverity("TaskCreate", {}, TEST_REPO_ROOT), Severity.AUTO_ALLOW);
    });

    it("TaskUpdate es AUTO_ALLOW", () => {
        assert.strictEqual(classifySeverity("TaskUpdate", { taskId: "1" }, TEST_REPO_ROOT), Severity.AUTO_ALLOW);
    });

    it("ToolSearch es AUTO_ALLOW", () => {
        assert.strictEqual(classifySeverity("ToolSearch", {}, TEST_REPO_ROOT), Severity.AUTO_ALLOW);
    });

    it("EnterPlanMode es AUTO_ALLOW", () => {
        assert.strictEqual(classifySeverity("EnterPlanMode", {}, TEST_REPO_ROOT), Severity.AUTO_ALLOW);
    });

    it("Edit sobre .claude/hooks/ es AUTO_ALLOW", () => {
        assert.strictEqual(
            classifySeverity("Edit", { file_path: TEST_REPO_ROOT + "/.claude/hooks/activity-logger-last.json" }, TEST_REPO_ROOT),
            Severity.AUTO_ALLOW
        );
    });

    it("Write sobre qa/evidence/ es AUTO_ALLOW", () => {
        assert.strictEqual(
            classifySeverity("Write", { file_path: TEST_REPO_ROOT + "/qa/evidence/1220/screenshot.png" }, TEST_REPO_ROOT),
            Severity.AUTO_ALLOW
        );
    });

    it("Edit sobre backend/src/ es LOW (no safe dir)", () => {
        assert.strictEqual(
            classifySeverity("Edit", { file_path: TEST_REPO_ROOT + "/backend/src/Main.kt" }, TEST_REPO_ROOT),
            Severity.LOW
        );
    });

    it("Bash con rm -rf es HIGH", () => {
        assert.strictEqual(
            classifySeverity("Bash", { command: "rm -rf /c/Workspaces/Intrale" }, TEST_REPO_ROOT),
            Severity.HIGH
        );
    });

    it("Bash con git push --force es HIGH", () => {
        assert.strictEqual(
            classifySeverity("Bash", { command: "git push --force origin main" }, TEST_REPO_ROOT),
            Severity.HIGH
        );
    });

    it("Bash con git push (sin force) es MEDIUM", () => {
        assert.strictEqual(
            classifySeverity("Bash", { command: "git push origin agent/1223-test" }, TEST_REPO_ROOT),
            Severity.MEDIUM
        );
    });

    it("Bash simple (git status) es LOW", () => {
        assert.strictEqual(
            classifySeverity("Bash", { command: "git status" }, TEST_REPO_ROOT),
            Severity.LOW
        );
    });

    it("WebSearch es LOW", () => {
        assert.strictEqual(classifySeverity("WebSearch", { query: "kotlin compose" }, TEST_REPO_ROOT), Severity.LOW);
    });

    it("Task/Agent es MEDIUM", () => {
        assert.strictEqual(classifySeverity("Task", { description: "test" }, TEST_REPO_ROOT), Severity.MEDIUM);
    });
});

// ─── DESTRUCTIVE_PATTERNS ───────────────────────────────────────────────────

describe("DESTRUCTIVE_PATTERNS", () => {
    it("detecta rm -rf", () => {
        assert.ok(DESTRUCTIVE_PATTERNS.some(p => p.test("rm -rf /")));
    });

    it("detecta rm -fr", () => {
        assert.ok(DESTRUCTIVE_PATTERNS.some(p => p.test("rm -fr /tmp")));
    });

    it("detecta git reset --hard", () => {
        assert.ok(DESTRUCTIVE_PATTERNS.some(p => p.test("git reset --hard HEAD~1")));
    });

    it("detecta DROP TABLE", () => {
        assert.ok(DESTRUCTIVE_PATTERNS.some(p => p.test("DROP TABLE users")));
    });

    it("NO detecta rm sin -r ni -f", () => {
        assert.ok(!DESTRUCTIVE_PATTERNS.some(p => p.test("rm file.txt")));
    });

    it("NO detecta git push sin --force", () => {
        assert.ok(!DESTRUCTIVE_PATTERNS.some(p => p.test("git push origin main")));
    });
});
