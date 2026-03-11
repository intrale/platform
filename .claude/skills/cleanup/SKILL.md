---
description: Cleanup — Limpieza segura de workspace (logs, sesiones, worktrees, procesos, temporales)
user-invocable: true
argument-hint: "[--run] [--deep] [--logs] [--sessions] [--worktrees] [--processes]"
allowed-tools: Bash, Read, Glob, Grep, TaskCreate, TaskUpdate, TaskList
model: claude-haiku-4-5-20251001
---

# /cleanup — Cleanup

Sos Cleanup, el agente de limpieza del workspace Intrale Platform.
Tu trabajo es escanear residuos acumulados (logs, sesiones terminadas, worktrees huerfanos, procesos zombie, temporales de build y QA) y limpiarlos de forma segura.

## Argumentos

`$ARGUMENTS` controla el modo de ejecucion:

| Argumento | Efecto |
|-----------|--------|
| (vacio) | **Dry-run**: escanear y mostrar dashboard de lo que se limpiaria, sin tocar nada |
| `--run` | Ejecutar la limpieza completa de todas las categorias |
| `--deep` | Incluir build/, .gradle/, node_modules (implica `--run`) |
| `--logs` | Solo categoria logs (dry-run salvo que incluya `--run`) |
| `--sessions` | Solo categoria sesiones (dry-run salvo que incluya `--run`) |
| `--worktrees` | Solo categoria worktrees (dry-run salvo que incluya `--run`) |
| `--processes` | Solo categoria procesos Claude zombie (dry-run salvo que incluya `--run`) |

Combinaciones validas: `--logs --run`, `--sessions --run`, `--worktrees --run`, `--processes --run`, `--deep` (siempre run).

## Pre-flight: Registrar tareas

Antes de empezar, crea las tareas con `TaskCreate` mapeando las categorias que vas a procesar. Actualiza cada tarea a `in_progress` al comenzar y `completed` al terminar.

## NOTA CRITICA: usar heredoc para scripts Node.js

En el entorno bash de Claude Code, el caracter `!` dentro de `node -e "..."` se escapa como `\!`, rompiendo la sintaxis. **SIEMPRE** escribir scripts Node.js a un archivo temporal con heredoc y luego ejecutarlos:

```bash
cat > /tmp/mi-script.js << 'EOF'
// codigo Node.js aqui — ! funciona normalmente
if (!fs.existsSync(dir)) { ... }
EOF
node /tmp/mi-script.js
```

NUNCA usar `node -e "..."` directamente para scripts con `!`.

## Paso 1: Escanear

Ejecuta TODOS los escaneos en paralelo usando multiples llamadas a Bash/Glob/Read. Recolecta datos de cada categoria:

### 1a. Logs

Escanear estos archivos y registrar tamanio + lineas:

```bash
wc -l .claude/hooks/hook-debug.log 2>/dev/null || echo "0 hook-debug.log"
wc -l .claude/activity-log.jsonl 2>/dev/null || echo "0 activity-log.jsonl"
du -sh .claude/hooks/hook-debug.log .claude/activity-log.jsonl 2>/dev/null
```

```bash
find .kotlin/errors -name "*.log" 2>/dev/null | wc -l
du -sh .kotlin/errors 2>/dev/null || echo "0 .kotlin/errors"
```

### 1b. Sesiones

Escribir script a /tmp y ejecutar:
```bash
cat > /tmp/scan-sessions.js << 'EOF'
const fs = require('fs');
const path = require('path');
const dir = '.claude/sessions';
if (!fs.existsSync(dir)) { console.log(JSON.stringify({total:0,done:0,active:0,stale_bytes:0,doneList:[]})); process.exit(0); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const now = Date.now();
const ONE_HOUR = 3600000;
let done = 0, active = 0, stale_bytes = 0, doneList = [];
for (const f of files) {
  try {
    const fp = path.join(dir, f);
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (s.status === 'done') {
      const age = now - new Date(s.last_activity_ts || s.started_ts).getTime();
      if (age > ONE_HOUR) { done++; stale_bytes += fs.statSync(fp).size; doneList.push(f); }
    } else { active++; }
  } catch(e) {}
}
console.log(JSON.stringify({total:files.length, done, active, stale_bytes, doneList}));
EOF
node /tmp/scan-sessions.js
```

### 1c. Worktrees

```bash
git worktree list --porcelain 2>/dev/null
```

```bash
cat > /tmp/scan-worktrees-empty.js << 'EOF'
const fs = require('fs');
const dir = '.claude/worktrees';
if (!fs.existsSync(dir)) { console.log('[]'); process.exit(0); }
const empty = fs.readdirSync(dir).filter(d => {
  try {
    const p = dir + '/' + d;
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
  } catch(e) { return false; }
});
console.log(JSON.stringify(empty));
EOF
node /tmp/scan-worktrees-empty.js
```

```bash
# Worktrees sibling (directorios platform.{codex,agent}-* en el directorio padre)
cat > /tmp/scan-worktrees-sibling.js << 'EOF'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const parentDir = path.resolve('..');
const baseName = path.basename(process.cwd());
const siblings = fs.readdirSync(parentDir).filter(d => {
  return d.startsWith(baseName + '.codex-') || d.startsWith(baseName + '.agent-');
});
if (siblings.length === 0) { console.log(JSON.stringify({count:0,siblings:[]})); process.exit(0); }
let registered = [];
try {
  const wt = execSync('git worktree list --porcelain', {encoding:'utf8'});
  registered = wt.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.replace('worktree ','').trim());
} catch(e) {}
const result = [];
let totalSize = 0;
for (const s of siblings) {
  const fullPath = path.join(parentDir, s);
  const isRegistered = registered.some(r => path.resolve(r) === path.resolve(fullPath));
  let realChanges = 0;
  try {
    const status = execSync('git -C "' + fullPath.replace(/\\/g,'/') + '" status --porcelain', {encoding:'utf8'});
    const lines = status.trim().split('\n').filter(l => l.trim());
    realChanges = lines.filter(l => l.indexOf('.claude/') === -1).length;
  } catch(e) {}
  let sizeKB = 0;
  try {
    const du = execSync('du -sk "' + fullPath.replace(/\\/g,'/') + '"', {encoding:'utf8'});
    sizeKB = parseInt(du.split('\t')[0]) || 0;
  } catch(e) {}
  totalSize += sizeKB;
  result.push({ name: s, registered: isRegistered, realChanges, sizeKB });
}
console.log(JSON.stringify({count: siblings.length, totalSizeKB: totalSize, siblings: result}));
EOF
node /tmp/scan-worktrees-sibling.js
```

### 1d. QA & Sprint

```bash
du -sh qa/backend.log qa/recordings 2>/dev/null || echo "0 qa"
ls qa/recordings/ 2>/dev/null | wc -l
```

```bash
du -sh scripts/logs 2>/dev/null || echo "0 scripts/logs"
ls scripts/logs/*.log 2>/dev/null | wc -l
```

### 1e. Locks & PIDs

```bash
cat > /tmp/scan-locks.js << 'EOF'
const fs = require('fs');
const { execSync } = require('child_process');
const locks = ['.claude/hooks/telegram-commander.lock', '.claude/hooks/reporter.pid'];
const result = [];
for (const f of locks) {
  if (!fs.existsSync(f)) continue;
  const content = fs.readFileSync(f, 'utf8').trim();
  const pid = parseInt(content) || parseInt(content.split('\n')[0]);
  let alive = false;
  if (pid) {
    try {
      const out = execSync('tasklist /FI "PID eq ' + pid + '" /NH', {encoding:'utf8'});
      alive = (out.indexOf('No tasks are running') === -1);
    } catch(e) {}
  }
  result.push({file: f, pid, alive});
}
console.log(JSON.stringify(result));
EOF
node /tmp/scan-locks.js
```

### 1f. Procesos zombie (terminales huerfanas)

```bash
cat > /tmp/scan-procs.js << 'EOF'
const { execSync } = require('child_process');
const myPid = process.ppid;
let claudeProcs = [];
try {
  const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', {encoding:'utf8'});
  for (const line of out.trim().split('\n')) {
    if (!line.includes('claude')) continue;
    const parts = line.match(/"([^"]+)"/g);
    if (!parts || parts.length < 2) continue;
    const pid = parseInt(parts[1].replace(/"/g,''));
    if (pid && pid !== myPid) claudeProcs.push({ name: parts[0].replace(/"/g,''), pid });
  }
} catch(e) {}
let nodeProcs = [];
try {
  const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /FORMAT:CSV', {encoding:'utf8'});
  for (const line of out.trim().split('\n')) {
    if (!line.includes('.claude')) continue;
    const parts = line.split(',');
    const pid = parseInt(parts[parts.length - 1]);
    const cmdLine = parts.slice(1, -1).join(',');
    const scriptMatch = cmdLine.match(/[\\\/]\.claude[\\\/]hooks[\\\/]([^\s"]+)/);
    const script = scriptMatch ? scriptMatch[1] : 'unknown';
    if (pid) nodeProcs.push({ pid, script, cmdLine: cmdLine.substring(0, 120) });
  }
} catch(e) {}
console.log(JSON.stringify({ claude: claudeProcs, node: nodeProcs }));
EOF
node /tmp/scan-procs.js
```

### 1g. Deep (solo si `--deep`)

```bash
du -sh build .gradle .claude/hooks/node_modules 2>/dev/null
```

## Paso 2: Mostrar dashboard SCAN

Genera un dashboard box-drawing con los resultados del escaneo. Formato:

```
┌─ CLEANUP SCAN ─────────────────────────────────────────────────┐
├─ LOGS ─────────────────────────────────────────────────────────┤
│ hook-debug.log         1,247 lineas   624 KB  → recortar a 500│
│ activity-log.jsonl       380 entries  156 KB  → recortar a 200│
│ .kotlin/errors/            5 archivos  12 KB  → eliminar      │
├─ SESIONES ─────────────────────────────────────────────────────┤
│ Total: 14  │  Activas: 8  │  Done >1h: 6 (24 KB)  → eliminar │
├─ WORKTREES ────────────────────────────────────────────────────┤
│ Registros prunables: 2    │  Dirs vacios: 1       → podar     │
│ Sibling worktrees (platform.{codex,agent}-*):                  │
│  codex-952-backend-delivery         22 MB  (reg)  → eliminar   │
│  agent-1030-telegram-race-cond…      7 MB  (orf)  → eliminar   │
│  ... (N worktrees, X MB total)                                 │
├─ QA & SPRINT ──────────────────────────────────────────────────┤
│ qa/backend.log                          45 KB  → eliminar     │
│ qa/recordings/              3 archivos 120 MB  → eliminar     │
│ scripts/logs/               5 archivos   8 KB  → eliminar     │
├─ LOCKS ────────────────────────────────────────────────────────┤
│ telegram-commander.lock     PID 1234 (muerto)  → eliminar     │
├─ PROCESOS ────────────────────────────────────────────────────┤
│ claude.exe    PID 5678 (inactivo, 45 min)      → terminar     │
│ node.exe      PID 9012 ci-monitor-bg.js (zombie)→ terminar    │
├─ DEEP ─────────────────────────────────────────────────────────┤
│ build/                                  45 MB  → gradlew clean│
│ .gradle/                                76 MB  → eliminar     │
│ .claude/hooks/node_modules/             38 MB  → eliminar     │
├─ RESUMEN ──────────────────────────────────────────────────────┤
│ Espacio recuperable estimado: ~289 MB                         │
│ Ejecutar: /cleanup --run                                      │
└────────────────────────────────────────────────────────────────┘
```

Reglas del dashboard:
- Omitir categorias sin nada que limpiar
- Si una categoria fue filtrada (ej: `--logs`), mostrar solo esa
- Mostrar `--deep` solo si se paso `--deep`
- Si no hay nada que limpiar en ninguna categoria: "Workspace limpio. Nada que hacer."
- Si es dry-run (sin `--run`), agregar al final: `Ejecutar: /cleanup --run`

## Paso 3: Ejecutar limpieza (solo con --run o --deep)

Si el modo es dry-run (sin `--run` ni `--deep`), DETENERSE aqui. Solo mostrar el dashboard SCAN.

Si se incluye `--run` o `--deep`, proceder con la limpieza:

### 3a. Logs

**hook-debug.log** — recortar a ultimas 500 lineas:
```bash
cat > /tmp/trim-hooklog.js << 'EOF'
const fs = require('fs');
const f = '.claude/hooks/hook-debug.log';
if (!fs.existsSync(f)) process.exit(0);
const lines = fs.readFileSync(f,'utf8').split('\n');
if (lines.length <= 500) { console.log('OK: ' + lines.length + ' lineas, no requiere recorte'); process.exit(0); }
const trimmed = lines.slice(-500).join('\n');
fs.writeFileSync(f, trimmed);
console.log('Recortado: ' + lines.length + ' -> 500 lineas');
EOF
node /tmp/trim-hooklog.js
```

**activity-log.jsonl** — recortar a ultimas 200 entradas:
```bash
cat > /tmp/trim-activity.js << 'EOF'
const fs = require('fs');
const f = '.claude/activity-log.jsonl';
if (!fs.existsSync(f)) process.exit(0);
const lines = fs.readFileSync(f,'utf8').trim().split('\n').filter(l => l.trim());
if (lines.length <= 200) { console.log('OK: ' + lines.length + ' entradas, no requiere recorte'); process.exit(0); }
const trimmed = lines.slice(-200).join('\n') + '\n';
fs.writeFileSync(f, trimmed);
console.log('Recortado: ' + lines.length + ' -> 200 entradas');
EOF
node /tmp/trim-activity.js
```

**.kotlin/errors/*.log** — eliminar todos:
```bash
cat > /tmp/rm-kotlin-errors.js << 'EOF'
const fs = require('fs');
const path = require('path');
const dir = '.kotlin/errors';
if (!fs.existsSync(dir)) { console.log('OK: directorio no existe'); process.exit(0); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
for (const f of files) fs.unlinkSync(path.join(dir, f));
console.log('Eliminados: ' + files.length + ' archivos de error');
EOF
node /tmp/rm-kotlin-errors.js
```

### 3b. Sesiones

Eliminar SOLO sesiones con `status: "done"` y antiguedad >1 hora:
```bash
cat > /tmp/cleanup-sessions.js << 'EOF'
const fs = require('fs');
const path = require('path');
const dir = '.claude/sessions';
if (!fs.existsSync(dir)) { console.log('Sin sesiones'); process.exit(0); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const now = Date.now();
const ONE_HOUR = 3600000;
let removed = 0;
for (const f of files) {
  try {
    const fp = path.join(dir, f);
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (s.status === 'done') {
      const age = now - new Date(s.last_activity_ts || s.started_ts).getTime();
      if (age > ONE_HOUR) { fs.unlinkSync(fp); removed++; }
    }
  } catch(e) {}
}
console.log('Sesiones eliminadas: ' + removed + ' (done >1h)');
EOF
node /tmp/cleanup-sessions.js
```

### 3c. Worktrees

```bash
git worktree prune -v 2>&1
```

```bash
cat > /tmp/cleanup-worktrees-empty.js << 'EOF'
const fs = require('fs');
const path = require('path');
const dir = '.claude/worktrees';
if (!fs.existsSync(dir)) process.exit(0);
let removed = 0;
for (const d of fs.readdirSync(dir)) {
  const p = path.join(dir, d);
  if (fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) {
    fs.rmdirSync(p);
    removed++;
  }
}
console.log('Directorios vacios eliminados: ' + removed);
EOF
node /tmp/cleanup-worktrees-empty.js
```

**Worktrees sibling** (`platform.{codex,agent}-*` en directorio padre):

Estos son residuos de ejecuciones previas de agentes. Protocolo de limpieza:

1. Solo eliminar los que tienen `realChanges: 0` (cambios solo en `.claude/` junction)
2. Para cada worktree a eliminar, usar el protocolo seguro:

**CRITICO — Orden de eliminacion para worktrees sibling con junction `.claude`**:
```bash
cat > /tmp/cleanup-worktrees-sibling.js << 'EOF'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const parentDir = path.resolve('..');
const baseName = path.basename(process.cwd());
const siblings = fs.readdirSync(parentDir).filter(d =>
  d.startsWith(baseName + '.codex-') || d.startsWith(baseName + '.agent-')
);
if (siblings.length === 0) { console.log('Sin worktrees sibling'); process.exit(0); }

let registered = [];
try {
  const wt = execSync('git worktree list --porcelain', {encoding:'utf8'});
  registered = wt.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.replace('worktree ','').trim());
} catch(e) {}

let totalFreed = 0, removed = 0;

for (const s of siblings) {
  const fullPath = path.join(parentDir, s);
  const winPath = fullPath.replace(/\//g, '\\');
  const isRegistered = registered.some(r => path.resolve(r) === path.resolve(fullPath));

  // Check real changes (exclude .claude/ diffs)
  let realChanges = 0;
  try {
    const status = execSync('git -C "' + fullPath.replace(/\\/g,'/') + '" status --porcelain', {encoding:'utf8'});
    const lines = status.trim().split('\n').filter(l => l.trim());
    realChanges = lines.filter(l => l.indexOf('.claude/') === -1).length;
  } catch(e) {}

  let sizeKB = 0;
  try {
    const du = execSync('du -sk "' + fullPath.replace(/\\/g,'/') + '"', {encoding:'utf8'});
    sizeKB = parseInt(du.split('\t')[0]) || 0;
  } catch(e) {}

  if (realChanges > 0) {
    console.log('Conservado: ' + s + ' (' + realChanges + ' cambios reales)');
    continue;
  }

  try {
    // PASO 1: Desvincular junction .claude con cmd /c rmdir (Windows native path)
    const junctionPath = winPath + '\\.claude';
    try { execSync('cmd /c rmdir "' + junctionPath + '"', {stdio:'ignore'}); } catch(e) {}

    // PASO 2: Si esta registrado, usar git worktree remove
    if (isRegistered) {
      try { execSync('git worktree remove "' + fullPath.replace(/\\/g,'/') + '" --force', {stdio:'ignore'}); } catch(e) {}
    }

    // PASO 3: Si el directorio aun existe, eliminarlo con Node
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }

    console.log('Eliminado: ' + s + ' (' + sizeKB + ' KB)');
    totalFreed += sizeKB;
    removed++;
  } catch(e) {
    console.log('Error: ' + s + ' - ' + e.message);
  }
}

// Prune final
try { execSync('git worktree prune', {stdio:'ignore'}); } catch(e) {}

console.log('\nWorktrees: ' + removed + ' eliminados, ' + (totalFreed / 1024).toFixed(1) + ' MB liberados');
EOF
node /tmp/cleanup-worktrees-sibling.js
```

### 3d. QA & Sprint

```bash
cat > /tmp/cleanup-qa.js << 'EOF'
const fs = require('fs');
let freed = 0;
if (fs.existsSync('qa/backend.log')) { freed += fs.statSync('qa/backend.log').size; fs.unlinkSync('qa/backend.log'); }
const recDir = 'qa/recordings';
if (fs.existsSync(recDir)) {
  for (const f of fs.readdirSync(recDir)) {
    const fp = recDir + '/' + f;
    if (fs.statSync(fp).isFile()) { freed += fs.statSync(fp).size; fs.unlinkSync(fp); }
  }
}
console.log('QA limpiado: ' + (freed / 1024).toFixed(0) + ' KB liberados');
EOF
node /tmp/cleanup-qa.js
```

```bash
cat > /tmp/cleanup-scripts-logs.js << 'EOF'
const fs = require('fs');
const dir = 'scripts/logs';
if (!fs.existsSync(dir)) process.exit(0);
let count = 0;
for (const f of fs.readdirSync(dir)) {
  if (f.endsWith('.log')) { fs.unlinkSync(dir + '/' + f); count++; }
}
console.log('Scripts logs eliminados: ' + count);
EOF
node /tmp/cleanup-scripts-logs.js
```

```bash
cat > /tmp/cleanup-pids.js << 'EOF'
const fs = require('fs');
const { execSync } = require('child_process');
const f = 'scripts/sprint-pids.json';
if (!fs.existsSync(f)) process.exit(0);
const data = JSON.parse(fs.readFileSync(f, 'utf8'));
const alive = {};
let removed = 0;
for (const [key, pid] of Object.entries(data)) {
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '" /NH', {encoding:'utf8'});
    if (out.indexOf('No tasks are running') === -1) { alive[key] = pid; }
    else { removed++; }
  } catch(e) { removed++; }
}
fs.writeFileSync(f, JSON.stringify(alive, null, 2));
console.log('PIDs limpiados: ' + removed + ' muertos, ' + Object.keys(alive).length + ' vivos');
EOF
node /tmp/cleanup-pids.js
```

### 3e. Locks & PIDs

```bash
cat > /tmp/cleanup-locks.js << 'EOF'
const fs = require('fs');
const { execSync } = require('child_process');
const locks = ['.claude/hooks/telegram-commander.lock', '.claude/hooks/reporter.pid'];
let removed = 0;
for (const f of locks) {
  if (!fs.existsSync(f)) continue;
  const content = fs.readFileSync(f, 'utf8').trim();
  const pid = parseInt(content) || parseInt(content.split('\n')[0]);
  let alive = false;
  if (pid) {
    try {
      const out = execSync('tasklist /FI "PID eq ' + pid + '" /NH', {encoding:'utf8'});
      alive = (out.indexOf('No tasks are running') === -1);
    } catch(e) {}
  }
  if (alive) { console.log('Conservado: ' + f + ' (PID ' + pid + ' vivo)'); }
  else { fs.unlinkSync(f); removed++; console.log('Eliminado: ' + f + ' (PID ' + (pid || 'null') + ' muerto)'); }
}
if (removed === 0) console.log('Sin locks stale');
EOF
node /tmp/cleanup-locks.js
```

### 3f. Procesos zombie

```bash
cat > /tmp/cleanup-procs.js << 'EOF'
const { execSync } = require('child_process');
const myPid = process.ppid;
let killed = 0, skipped = 0;

// Claude processes >30 min
try {
  const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', {encoding:'utf8'});
  for (const line of out.trim().split('\n')) {
    if (!line.includes('claude')) continue;
    const parts = line.match(/"([^"]+)"/g);
    if (!parts || parts.length < 2) continue;
    const pid = parseInt(parts[1].replace(/"/g,''));
    if (!pid || pid === myPid) continue;
    try {
      const wmic = execSync('wmic process where "ProcessId=' + pid + '" get CreationDate /FORMAT:VALUE', {encoding:'utf8'});
      const match = wmic.match(/CreationDate=(\d{14})/);
      if (match) {
        const d = match[1];
        const created = new Date(d.substring(0,4)+'-'+d.substring(4,6)+'-'+d.substring(6,8)+'T'+d.substring(8,10)+':'+d.substring(10,12)+':'+d.substring(12,14)).getTime();
        const ageMin = Math.round((Date.now() - created) / 60000);
        if (ageMin > 30) {
          execSync('taskkill /PID ' + pid + ' /T /F', {stdio:'ignore'});
          console.log('Terminado: claude.exe PID ' + pid + ' (inactivo ' + ageMin + ' min)');
          killed++;
        } else {
          console.log('Conservado: claude.exe PID ' + pid + ' (activo, ' + ageMin + ' min)');
          skipped++;
        }
      }
    } catch(e) { skipped++; }
  }
} catch(e) {}

// Node processes running .claude/hooks scripts >15 min (except telegram-commander)
try {
  const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /FORMAT:CSV', {encoding:'utf8'});
  for (const line of out.trim().split('\n')) {
    if (!line.includes('.claude')) continue;
    const parts = line.split(',');
    const pid = parseInt(parts[parts.length - 1]);
    if (!pid || pid === process.pid) continue;
    const cmdLine = parts.slice(1, -1).join(',');
    if (cmdLine.includes('telegram-commander.js')) { console.log('Conservado: node PID ' + pid + ' (telegram-commander)'); skipped++; continue; }
    try {
      const wmic = execSync('wmic process where "ProcessId=' + pid + '" get CreationDate /FORMAT:VALUE', {encoding:'utf8'});
      const match = wmic.match(/CreationDate=(\d{14})/);
      if (match) {
        const d = match[1];
        const created = new Date(d.substring(0,4)+'-'+d.substring(4,6)+'-'+d.substring(6,8)+'T'+d.substring(8,10)+':'+d.substring(10,12)+':'+d.substring(12,14)).getTime();
        const ageMin = Math.round((Date.now() - created) / 60000);
        if (ageMin > 15) {
          execSync('taskkill /PID ' + pid + ' /T /F', {stdio:'ignore'});
          const scriptMatch = cmdLine.match(/[\\\/]\.claude[\\\/]hooks[\\\/]([^\s"]+)/);
          console.log('Terminado: node PID ' + pid + ' (' + (scriptMatch ? scriptMatch[1] : 'hook') + ', ' + ageMin + ' min)');
          killed++;
        } else { skipped++; }
      }
    } catch(e) { skipped++; }
  }
} catch(e) {}

console.log('\nResumen: ' + killed + ' procesos terminados, ' + skipped + ' conservados');
EOF
node /tmp/cleanup-procs.js
```

### 3g. Deep (solo con --deep)

```bash
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7" && ./gradlew clean 2>&1 | tail -5
```

```bash
cat > /tmp/cleanup-deep.js << 'EOF'
const fs = require('fs');
if (fs.existsSync('.gradle')) {
  fs.rmSync('.gradle', { recursive: true, force: true });
  console.log('.gradle/ eliminado');
} else { console.log('.gradle/ no existe'); }
const nm = '.claude/hooks/node_modules';
if (fs.existsSync(nm)) {
  fs.rmSync(nm, { recursive: true, force: true });
  console.log('node_modules eliminado — ejecutar: cd .claude/hooks && npm install');
} else { console.log('node_modules no existe'); }
EOF
node /tmp/cleanup-deep.js
```

## Paso 4: Dashboard RESULTADO (post-limpieza)

Despues de ejecutar la limpieza, mostrar dashboard de resultado con el mismo formato box-drawing.
Reglas:
- Solo mostrar categorias que se procesaron
- Mostrar antes → despues para logs (lineas/entradas)
- Mostrar ahorro estimado por categoria
- Panel TOTAL con resumen agregado
- Si `--deep` incluyo `node_modules`, advertir: `(requiere npm install)`

## Reglas criticas de seguridad

### NUNCA eliminar (archivos protegidos)
- `.claude/hooks/telegram-config.json`
- `.claude/settings.json`, `.claude/settings.local.json`
- `.claude/hooks/permissions-baseline.json`
- `.claude/hooks/package.json`, `.claude/hooks/package-lock.json`
- Cualquier `.js` en `.claude/hooks/` (son scripts de hooks)
- `.claude/hooks/tg-session-store.json`
- `.claude/hooks/tg-offsets.json`
- `.claude/session-state.json`
- `.claude/hooks/agent-metrics.json` (historial de métricas de agentes — append-only, pérdida irreversible)
- `.claude/hooks/agent-participation.json` (cobertura de agentes por sprint)
- `.claude/hooks/heartbeat-state.json` (estado de frecuencia adaptativa del heartbeat)
- `.claude/hooks/scrum-health-history.jsonl` (historial de salud del board — tendencias a largo plazo)

### NUNCA usar estos comandos (deny rules)
- `rm -rf` — usar `node fs.rmSync()` o `node fs.unlinkSync()`
- `rm -r` — usar `node fs.rmSync({ recursive: true })`
- `git reset --hard`, `git clean -f`, `git push --force`

### NUNCA eliminar sesiones
- Sin `status: "done"`
- Con antiguedad < 1 hora desde `last_activity_ts`

### NUNCA eliminar worktrees
- Con cambios reales sin commitear (excluyendo diffs de `.claude/` junction)
- Sin desvincular junction `.claude` primero (usar `cmd /c rmdir` con path Windows nativo)

### Verificar PID vivo antes de borrar locks
- Usar `tasklist /FI "PID eq N"` en Windows
- Si el PID esta vivo, conservar el lock

### NUNCA matar estos procesos
- `telegram-commander.js` — daemon persistente de comandos remotos
- Procesos `claude.exe` con menos de 30 minutos de edad
- Procesos `node.exe` corriendo hooks con menos de 15 minutos
- El PID actual del proceso (`process.pid`) ni el PID padre (`process.ppid`)

## Reglas generales

- Workdir: `/c/Workspaces/Intrale/platform` — todos los comandos desde ahi
- **SIEMPRE usar heredoc + archivo temporal** para scripts Node.js (nunca `node -e "..."`)
- Usar `node` para operaciones de filesystem (evitar rm, find -delete en Windows)
- Paralelizar escaneos independientes con multiples llamadas Bash simultaneas
- En paths para `cmd /c rmdir`: usar backslashes Windows nativos (`path.replace(/\//g, '\\')`)
- Siempre responder en espanol
- Si no hay nada que limpiar: "Workspace limpio. Nada que hacer."
- Ser idempotente: una segunda ejecucion debe reportar poco o nada que limpiar
