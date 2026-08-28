# -*- coding: utf-8 -*-
import io, re

p = r'.pipeline/lib/file-lock.js'
s = io.open(p, encoding='utf8').read()
orig = s

def sub1(old, new, label):
    global s
    assert old in s, 'no matcheo: ' + label
    assert s.count(old) == 1, 'ambiguo: ' + label
    s = s.replace(old, new, 1)

# ---------------------------------------------------------------- FIX 1
OLD_PIDALIVE = """function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err && err.code === 'ESRCH') return false;
        if (err && err.code === 'EPERM') return true; // existe, no podemos firmar
        return false;
    }
}"""

NEW_PIDALIVE = u"""function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // #6459 — FAIL-CLOSED: sólo ESRCH — la única respuesta que afirma
        // positivamente "ese PID no existe" — cuenta como muerto. CUALQUIER otro
        // error (EPERM, EINVAL, UNKNOWN, EACCES…) significa "no pude
        // determinarlo": ante la duda asumimos VIVO.
        //
        // El catch-all anterior era `return false` (fail-OPEN). En Windows
        // `process.kill(pid,0)` se resuelve con OpenProcess(), que bajo
        // fork-storm puede fallar con un código distinto de ESRCH/EPERM aunque
        // el proceso esté vivo → falso "muerto" → robo del lock de un holder
        // vivo → dual-hold → lost-update silencioso.
        //
        // Costo: un PID que murió y devuelve un error raro tarda hasta
        // STALE_AGE_MS en recuperarse por antigüedad en vez de al instante. Es
        // el lado correcto para equivocarse: demorar la recuperación de un
        // huérfano es recuperable; corromper el archivo en silencio no.
        if (err && err.code === 'ESRCH') return false;
        return true;
    }
}

/**
 * Identidad única del lock (#6459). Dos locks distintos NUNCA comparten
 * `nonce`, así que sirve para verificar —antes de borrar— que el archivo que
 * estamos por remover sigue siendo EXACTAMENTE el que juzgamos stale, y no un
 * lock nuevo que otro proceso creó legítimamente mientras deliberábamos.
 *
 * Los locks viejos (pre-#6459) no tienen `nonce`; para ellos caemos a
 * pid+startTime, que es la mejor identidad disponible.
 */
function lockIdentity(meta) {
    if (!meta || typeof meta !== 'object') return null;
    if (meta._corrupt) return '_corrupt';
    if (typeof meta.nonce === 'string' && meta.nonce) return 'n:' + meta.nonce;
    return 'p:' + meta.pid + ':' + meta.startTime;
}

/**
 * Remoción VERIFICADA de un lock que juzgamos stale (#6459).
 *
 * Causa raíz que esto elimina — TOCTOU sobre el archivo de lock
 * ---------------------------------------------------------------
 * El patrón previo era `if (isStale(holder)) { fs.unlinkSync(lockPath); }`: se
 * juzgaba con la meta leída en el instante T y se borraba en T+Δ, SIN
 * revalidar. Bajo contención, en ese Δ el holder libera y otro proceso toma el
 * lock legítimamente — y el unlink se lleva puesto ese lock NUEVO. Los dos
 * quedan "adentro" → lost-update silencioso (ambos salen 0, uno pisa al otro).
 *
 * Traza real capturada (#6459, 16 workers sobre el mismo waves.json):
 *     184954 pid=8208  REL-true              <- 8208 libera
 *     184955 pid=4832  (lock desaparecido)   <- 4832 lo juzga stale
 *     184956 pid=20328 ACQ-excl              <- 20328 toma el lock legítimamente
 *     184972 pid=4832  ACQ-excl              <- 4832 borra el lock FRESCO de 20328
 *     ...resto escribe 2..14...
 *     188737 pid=20328 WRITE issues=2        <- 20328 escribe su snapshot viejo
 *                                               y pisa los writes 2..14
 * Resultado: `issues=3, exitosos=16` (13 writes perdidos, 0 errores).
 *
 * Fix: releer la meta inmediatamente antes del unlink y borrar SÓLO si la
 * identidad sigue siendo la misma que juzgamos. Si cambió (otro proceso ya tomó
 * el lock) o el archivo ya no está, NO borramos nada y dejamos que el loop
 * reevalúe desde cero contra el estado real.
 *
 * @returns {boolean} true si removimos el lock que juzgamos; false si no.
 */
function removeStaleLock(lockPath, judgedMeta) {
    const judged = lockIdentity(judgedMeta);
    if (!judged) return false;
    const current = lockIdentity(readLockMeta(lockPath));
    // Desapareció (el holder liberó) o cambió de dueño → no hay nada NUESTRO
    // que borrar. Borrar acá sería robarle el lock a un holder legítimo.
    if (current === null || current !== judged) return false;
    try {
        fs.unlinkSync(lockPath);
        return true;
    } catch {
        return false; // otro lo removió primero; el loop reevalúa
    }
}"""
sub1(OLD_PIDALIVE, NEW_PIDALIVE, 'isPidAlive')

# ---------------------------------------------------------------- FIX 2 (nonce)
sub1("        pid: process.pid,",
     u"""        pid: process.pid,
        // #6459 — identidad única del lock; habilita la remoción VERIFICADA de
        // locks stale (ver removeStaleLock).
        nonce: crypto.randomBytes(8).toString('hex'),""",
     'buildLockMeta nonce')

# ---------------------------------------------------------------- FIX 3 (rama PID muerto)
sub1("    if (!isPidAlive(meta.pid)) return true;",
     u"""    // #6459 — Un lock JOVEN (< STALE_AGE_MS) NUNCA se roba, ni siquiera con el
    // PID reportado como muerto. Cierra la última asimetría de `isStale`: las
    // ramas `_corrupt` (#3735) y PID-vivo ya exigían antigüedad > 60s, pero
    // ésta robaba al instante, así que un ÚNICO falso "muerto" de `isPidAlive`
    // bastaba para el dual-hold. Si el holder murió de verdad, el lock se
    // recupera igual por antigüedad a los 60s; mientras tanto los contendientes
    // fallan fuerte con ELOCK_TIMEOUT (exit != 0, contabilizado como fracaso) en
    // vez de clobberear en silencio.
    if (!isPidAlive(meta.pid)) {
        let deadMtimeMs;
        try {
            deadMtimeMs = fs.statSync(lockPath).mtimeMs;
        } catch {
            return false; // #6459 — desapareció: nada que robar (ver abajo)
        }
        return (Date.now() - deadMtimeMs) >= STALE_AGE_MS;
    }""",
     'rama pid muerto')

# ---------------------------------------------------------------- FIX 4 (live-gone)
OLD_LIVEGONE = u"""    } catch {
        return true; // si el lock desapareció, no es ours problem
    }"""
NEW_LIVEGONE = u"""    } catch {
        // #6459 — "el lock desapareció" NO es "el lock está stale".
        //
        // Antes esto devolvía `true`, y el caller respondía con un
        // `fs.unlinkSync(lockPath)` a ciegas. Pero si el archivo ya no está es
        // porque el holder LIBERÓ — y para cuando ejecutamos el unlink, otro
        // proceso pudo haber tomado el lock legítimamente. Ese unlink le borraba
        // el lock recién creado y habilitaba el dual-hold: es el trigger que
        // aparece en el 100% de las trazas de lost-update de #6459 (lock
        // desaparecido inmediatamente antes de dos ACQ-excl solapados).
        //
        // Lo correcto es NO declararlo stale: el loop reintenta
        // `atomicCreateLock`, que es atómico y resuelve la carrera sin destruir
        // el lock de nadie.
        return false;
    }"""
sub1(OLD_LIVEGONE, NEW_LIVEGONE, 'live-gone')

# ---------------------------------------------------------------- FIX 5 (_corrupt gone)
OLD_CORR = u"""        try { lockMtimeMs = fs.statSync(lockPath).mtimeMs; } catch { return true; }"""
NEW_CORR = u"""        // #6459 — desapareció => NO stale (ver la rama de PID vivo): el loop
        // reintenta el create atómico en vez de unlinkear el lock de otro.
        try { lockMtimeMs = fs.statSync(lockPath).mtimeMs; } catch { return false; }"""
sub1(OLD_CORR, NEW_CORR, 'corrupt-gone')

# ---------------------------------------------------------------- FIX 6 (unlink ciego sync)
OLD5 = """            if (isStale(holder, lockPath)) {
                try { fs.unlinkSync(lockPath); } catch {}
                continue;
            }"""
NEW5 = u"""            if (isStale(holder, lockPath)) {
                // #6459 — remoción VERIFICADA: sólo borramos si el lock sigue
                // siendo el mismo que juzgamos stale (ver removeStaleLock).
                removeStaleLock(lockPath, holder);
                continue;
            }"""
sub1(OLD5, NEW5, 'unlink sync')

# ---------------------------------------------------------------- FIX 7 (unlink ciego async)
OLD6 = """                try { fs.unlinkSync(lockPath); } catch {}
                continue; // retry inmediato"""
NEW6 = u"""                // #6459 — remoción VERIFICADA (ver removeStaleLock).
                removeStaleLock(lockPath, holder);
                continue; // retry inmediato"""
sub1(OLD6, NEW6, 'unlink async')

# ---------------------------------------------------------------- exports
sub1("""        readLockMeta,
        isPidAlive,""",
     """        readLockMeta,
        isPidAlive,
        lockIdentity,
        removeStaleLock,""",
     'exports')

assert s != orig
io.open(p, 'w', encoding='utf8', newline='').write(s)
print('fix completo aplicado')
