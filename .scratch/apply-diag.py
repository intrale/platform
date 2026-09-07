import io,sys
# --- file-lock diag ---
p=r'.pipeline/lib/file-lock.js'
s=io.open(p,encoding='utf8').read()
if '_diagSteal' not in s:
    diag='''
function _diagSteal(lockPath, meta, reason) {
    const f = process.env.LOCK_DIAG_FILE;
    if (!f) return;
    try {
        fs.appendFileSync(f, JSON.stringify({ t: Date.now(), by: process.pid,
            holder: meta && meta.pid, reason }) + String.fromCharCode(10));
    } catch {}
}
'''
    s=s.replace('function isStale(meta, lockPath) {', diag+'\nfunction isStale(meta, lockPath) {',1)
    s=s.replace("""        _diagSteal""","""        _diagSteal""")
    # corrupt branch
    s=s.replace("""        let lockMtimeMs;
        try { lockMtimeMs = fs.statSync(lockPath).mtimeMs; } catch { return true; }
        const lockAgeMs = Date.now() - lockMtimeMs;
        if (lockAgeMs < STALE_AGE_MS) return false; // creación en curso, NO stale
        return true;""",
"""        let lockMtimeMs;
        try { lockMtimeMs = fs.statSync(lockPath).mtimeMs; } catch { _diagSteal(lockPath, meta, 'corrupt-gone'); return true; }
        const lockAgeMs = Date.now() - lockMtimeMs;
        if (lockAgeMs < STALE_AGE_MS) return false; // creación en curso, NO stale
        _diagSteal(lockPath, meta, 'corrupt-old');
        return true;""",1)
    # dead branch (post-fix)
    s=s.replace("""        } catch {
            return true; // el lock ya no está — nada que robar
        }
        return (Date.now() - deadMtimeMs) >= STALE_AGE_MS;""",
"""        } catch {
            _diagSteal(lockPath, meta, 'dead-gone'); return true;
        }
        const dr = (Date.now() - deadMtimeMs) >= STALE_AGE_MS;
        if (dr) _diagSteal(lockPath, meta, 'dead-old');
        return dr;""",1)
    # live-pid statSync fail + recycled
    s=s.replace("""    } catch {
        return true; // si el lock desapareció, no es ours problem
    }""","""    } catch {
        _diagSteal(lockPath, meta, 'live-gone'); return true;
    }""",1)
    s=s.replace("""    if (meta.pid === process.pid && meta.startTime !== PROCESS_START_ISO) {
        return true;
    }""","""    if (meta.pid === process.pid && meta.startTime !== PROCESS_START_ISO) {
        _diagSteal(lockPath, meta, 'pid-recycled'); return true;
    }""",1)
    # acquire/release
    s=s.replace("""            if (holder && holder.pid === process.pid && holder.startTime === PROCESS_START_ISO) {
                return { acquired: true, reentrant: true, lockPath };
            }""","""            if (holder && holder.pid === process.pid && holder.startTime === PROCESS_START_ISO) {
                _diagSteal(lockPath, holder, 'REENTRANT-sync');
                return { acquired: true, reentrant: true, lockPath };
            }""",1)
    s=s.replace("""    try {
        return fn();
    } finally {
        if (!acquisition.reentrant) {
            releaseLock(filePath);
        }
    }
}""","""    _diagSteal(acquisition.lockPath, { pid: process.pid }, acquisition.reentrant ? 'ACQ-reent' : 'ACQ-excl');
    try {
        return fn();
    } finally {
        if (!acquisition.reentrant) {
            _diagSteal(acquisition.lockPath, { pid: process.pid }, 'REL-' + releaseLock(filePath));
        }
    }
}""",1)
    io.open(p,'w',encoding='utf8',newline='').write(s)
# --- waves diag ---
p2=r'.pipeline/lib/waves.js'
w=io.open(p2,encoding='utf8').read()
if 'ev: 4459' not in w and "ev: 'write'" not in w:
    w=w.replace("""function atomicWriteFile(targetPath, data) {
    const tmp = targetPath + '.tmp';""",
"""function atomicWriteFile(targetPath, data) {
    if (process.env.LOCK_DIAG_FILE) {
        try {
            let cnt = -1;
            try { cnt = (JSON.parse(data).active_wave.issues || []).length; } catch (e) {}
            fs.appendFileSync(process.env.LOCK_DIAG_FILE, JSON.stringify({
                ev: 'write', by: process.pid, t: Date.now(),
                tgt: require('path').basename(targetPath), issues: cnt }) + String.fromCharCode(10));
        } catch (e) {}
    }
    const tmp = targetPath + '.tmp';""",1)
    # log de la LECTURA bajo lock
    w=w.replace("""    invalidateCache();
    const state = loadWaves();""",
"""    invalidateCache();
    const state = loadWaves();
    if (process.env.LOCK_DIAG_FILE) {
        try { fs.appendFileSync(process.env.LOCK_DIAG_FILE, JSON.stringify({
            ev: 'read', by: process.pid, t: Date.now(),
            issues: ((state.active_wave || {}).issues || []).length }) + String.fromCharCode(10)); } catch (e) {}
    }""",1)
    io.open(p2,'w',encoding='utf8',newline='').write(w)
print('diag aplicado')
