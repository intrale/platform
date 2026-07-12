# git-filter-repo --filename-callback body — Ola 9.1 (#4663)
# Selecciona el subconjunto MOTOR (frontera kernel-migration-plan.md §2.1/§2.3)
# y lo re-ubica en el layout del repo del kernel (kernel-repo-design.md §1):
#   .pipeline/pulpo.js        -> core/pulpo.js
#   .pipeline/dashboard.js    -> core/dashboard.js
#   .pipeline/lib/**          -> lib/**            (EXCEPTO apk-freshness.js -> DROP, es adaptador)
#   .claude/skills/<motor>/** -> skills/<motor>/**
#   .claude/skills/_frozen/scrum/** -> skills/_frozen/scrum/**
#   .claude/hooks/<motor>.js  -> hooks/<motor>.js
# Cualquier otro path (producto/adaptador) -> None (se descarta).
# `filename` llega como bytes; devolver bytes (mantener+renombrar) o None (descartar).
name = filename.decode('utf-8', 'surrogateescape')

# Guardia de frontera: apk-freshness.js es adaptador de producto -> nunca migra.
if name == '.pipeline/lib/apk-freshness.js':
    return None

if name.startswith('.pipeline/lib/'):
    return ('lib/' + name[len('.pipeline/lib/'):]).encode('utf-8', 'surrogateescape')

if name == '.pipeline/pulpo.js':
    return b'core/pulpo.js'
if name == '.pipeline/dashboard.js':
    return b'core/dashboard.js'

if name.startswith('.claude/skills/_frozen/scrum/'):
    return ('skills/_frozen/scrum/' + name[len('.claude/skills/_frozen/scrum/'):]).encode('utf-8', 'surrogateescape')

MOTOR_SKILLS = ('delivery', 'branch', 'cost', 'handoff', 'reset', 'ops',
                'auth', 'monitor', 'ghostbusters', 'pipeline-dev')
for s in MOTOR_SKILLS:
    p = '.claude/skills/' + s + '/'
    if name.startswith(p):
        return ('skills/' + s + '/' + name[len(p):]).encode('utf-8', 'surrogateescape')

MOTOR_HOOKS = ('agent-concurrency-check.js', 'agent-registry.js', 'activity-logger.js')
for h in MOTOR_HOOKS:
    if name == '.claude/hooks/' + h:
        return ('hooks/' + h).encode('utf-8', 'surrogateescape')

return None
