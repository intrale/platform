// Test P-18: Health check proactivo — auto-reparación de worktrees y deduplicación de alertas (#1224)
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HC_FILE = path.join(__dirname, "..", "health-check.js");
const CLEANUP_FILE = path.join(__dirname, "..", "cleanup-worktrees.js");
const source = fs.readFileSync(HC_FILE, "utf8");
const cleanupSource = fs.readFileSync(CLEANUP_FILE, "utf8");

describe("P-18: Health check proactivo con auto-reparación (#1224)", () => {

    // ─── Detección via git worktree list --porcelain ────────────────────────

    it("usa git worktree list --porcelain como fuente de verdad", () => {
        assert.ok(source.includes("git worktree list --porcelain"),
            "Debería usar 'git worktree list --porcelain' para detectar worktrees");
    });

    it("contiene función parseGitWorktreeList", () => {
        assert.ok(source.includes("function parseGitWorktreeList"),
            "Debería tener parseGitWorktreeList para parsear output porcelain");
    });

    it("detecta worktrees fantasma (registrados en git pero sin directorio)", () => {
        assert.ok(source.includes("fantasma"),
            "Debería manejar worktrees fantasma (en git pero sin directorio)");
    });

    // ─── Reparación por capas ───────────────────────────────────────────────

    it("contiene función tryRepairWorktree con estrategia por capas", () => {
        assert.ok(source.includes("function tryRepairWorktree"),
            "Debería tener tryRepairWorktree para reparación por capas");
    });

    it("capa 1: git worktree remove --force", () => {
        assert.ok(source.includes('git worktree remove') && source.includes('--force'),
            "Capa 1 debería usar git worktree remove --force");
    });

    it("capa 2: cmd /c rmdir para junctions NTFS", () => {
        assert.ok(source.includes('cmd /c rmdir'),
            "Capa 2 debería usar cmd /c rmdir para desmontar junctions NTFS");
    });

    it("capa 3: git worktree prune como fallback", () => {
        assert.ok(source.includes("git worktree prune"),
            "Capa 3 debería usar git worktree prune");
    });

    it("NUNCA usa rm -rf como comando ejecutable (protección junctions NTFS)", () => {
        // Verificar que rm -rf no aparece en execSync/exec calls — comentarios OK
        const execLines = source.split("\n").filter(l =>
            l.includes("rm -rf") && !l.trim().startsWith("//") && !l.trim().startsWith("*")
        );
        assert.equal(execLines.length, 0,
            "NUNCA debe usar rm -rf en código ejecutable — riesgo junctions NTFS");
    });

    it("retorna estrategia usada para cada worktree limpiado", () => {
        assert.ok(source.includes("result.strategies"),
            "Debería trackear qué estrategia funcionó en result.strategies");
    });

    // ─── Deduplicación de alertas ───────────────────────────────────────────

    it("contiene NOTIFICATION_COOLDOWN_MS para deduplicación", () => {
        assert.ok(source.includes("NOTIFICATION_COOLDOWN_MS"),
            "Debería definir NOTIFICATION_COOLDOWN_MS para cooldown de alertas");
    });

    it("contiene función shouldNotifyProblem", () => {
        assert.ok(source.includes("function shouldNotifyProblem"),
            "Debería tener shouldNotifyProblem para filtrar alertas duplicadas");
    });

    it("usa last_notified_at para rastrear última notificación", () => {
        assert.ok(source.includes("last_notified_at"),
            "Debería usar last_notified_at para deduplicación temporal");
    });

    it("suprime alertas si occurrences > 5 y no fue auto-reparado y cooldown activo", () => {
        assert.ok(source.includes("occurrences > 5") && source.includes("auto_fixed"),
            "Debería suprimir alertas para problemas persistentes (>5 ocurrencias, no auto-fixed)");
    });

    // ─── Escalada dinámica ──────────────────────────────────────────────────

    it("dead_worktrees ya NO está en NO_ESCALATE (escala dinámicamente)", () => {
        // NO_ESCALATE no debe contener dead_worktrees
        const noEscalateMatch = source.match(/NO_ESCALATE\s*=\s*new\s+Set\(\[(.*?)\]\)/);
        assert.ok(noEscalateMatch, "Debería definir NO_ESCALATE como Set");
        assert.ok(!noEscalateMatch[1].includes("dead_worktrees"),
            "dead_worktrees NO debe estar en NO_ESCALATE — ahora escala tras THRESHOLD_ISSUE ciclos");
    });

    // ─── cleanup-worktrees.js standalone ────────────────────────────────────

    it("cleanup-worktrees.js existe", () => {
        assert.ok(fs.existsSync(CLEANUP_FILE),
            "cleanup-worktrees.js debería existir como script standalone");
    });

    it("cleanup-worktrees.js soporta --dry-run", () => {
        assert.ok(cleanupSource.includes("--dry-run"),
            "Debería soportar flag --dry-run");
    });

    it("cleanup-worktrees.js verifica estado de PR antes de limpiar", () => {
        assert.ok(cleanupSource.includes("checkPRStatus") || cleanupSource.includes("pr list"),
            "Debería verificar estado de PR (mergeado/cerrado) antes de eliminar");
    });

    it("cleanup-worktrees.js limpia junction NTFS con cmd /c rmdir", () => {
        assert.ok(cleanupSource.includes("cmd /c rmdir"),
            "Debería desmontar junctions NTFS con cmd /c rmdir");
    });

    it("cleanup-worktrees.js ejecuta git worktree remove --force", () => {
        assert.ok(cleanupSource.includes("git worktree remove") && cleanupSource.includes("--force"),
            "Debería usar git worktree remove --force");
    });

    it("cleanup-worktrees.js limpia branch local y remota", () => {
        assert.ok(cleanupSource.includes("git branch -D"),
            "Debería eliminar branch local con git branch -D");
        assert.ok(cleanupSource.includes("git push origin --delete"),
            "Debería eliminar branch remota con git push origin --delete");
    });

    it("cleanup-worktrees.js notifica a Telegram", () => {
        assert.ok(cleanupSource.includes("sendAlert"),
            "Debería notificar resultados a Telegram vía sendAlert");
    });

    it("cleanup-worktrees.js NUNCA usa rm -rf como comando ejecutable", () => {
        const execLines = cleanupSource.split("\n").filter(l =>
            l.includes("rm -rf") && !l.trim().startsWith("//") && !l.trim().startsWith("*")
        );
        assert.equal(execLines.length, 0,
            "NUNCA debe usar rm -rf en código ejecutable — protección junctions NTFS");
    });

    it("cleanup-worktrees.js acepta worktrees via stdin (porcelain)", () => {
        assert.ok(cleanupSource.includes("stdin") && cleanupSource.includes("worktree "),
            "Debería parsear stdin en formato porcelain de git worktree list");
    });

    it("cleanup-worktrees.js ejecuta git worktree prune al final", () => {
        assert.ok(cleanupSource.includes("git worktree prune"),
            "Debería ejecutar git worktree prune para limpiar referencias huérfanas");
    });
});
