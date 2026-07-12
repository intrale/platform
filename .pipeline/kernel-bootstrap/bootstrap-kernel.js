'use strict';

// -----------------------------------------------------------------------------
// bootstrap-kernel.js — Scaffolding reproducible del repo del kernel (issue #4662).
//
// Genera el staging del commit 1 del repo del kernel (core/ lib/ contracts/ vacías
// con .gitkeep, README.md, .gitignore) y ejecuta el escaneo de secretos fail-closed
// ANTES de que exista historia git. NO commitea ni crea el repo remoto: eso lo hace
// el operador/dev con `git init` + `gh repo create --private` una vez el escaneo
// sale verde (ver README de este directorio). Es la parte automatizable y testeable.
//
// Orden estricto (RS-1 · kernel-migration-plan.md §3.3):
//   scaffold → escaneo verde → (recién entonces) git init/commit/push manual.
//
// Uso: node bootstrap-kernel.js <destino>
//   <destino> — carpeta donde se materializa el staging del kernel (debe estar vacía
//               o no existir; nace SIN historia heredada del producto).
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { assertClean } = require('./scan-staging');

const KERNEL_DIRS = ['core', 'lib', 'contracts'];

const GITIGNORE = `# Defensa en profundidad (RS-4 · #4662): el escaneo fail-closed no es la única
# barrera. Estos patrones evitan que un archivo obvio de secretos entre al commit.
*.env
.env*
credentials.json
secrets/
*.pem
*.key
*.p12
id_rsa*

# Ruido de tooling Node (el kernel es Node.js puro; deps llegan en pasos siguientes).
node_modules/
`;

const README = `# Kernel operativo

Repositorio del **kernel operativo** — el motor de orquestación agnóstico del producto.

> Nace **vacío** y **al lado** del producto, sin historia heredada. Es agnóstico de
> stack: no conoce Kotlin, Compose, ni ningún producto concreto. El producto lo
> consume como paquete versionado (ver diseño en el repo del producto,
> \`docs/pipeline/kernel-repo-design.md §2\`).

## Layout mínimo (este commit)

| Carpeta      | Responsabilidad                                                        | Estado          |
|--------------|------------------------------------------------------------------------|-----------------|
| \`core/\`      | Motor de orquestación (Pulpo/intake-outtake, scheduler, lifecycle de fases, circuit breaker, routing). | vacía (\`.gitkeep\`) |
| \`lib/\`       | Utilidades transversales del motor (mecanismos de carga/redacción/FS/git, **sin** datos ni scopes concretos). | vacía (\`.gitkeep\`) |
| \`contracts/\` | Interfaz kernel↔adaptador (puertos, extension points, JSON Schema del manifiesto). | vacía (\`.gitkeep\`) |

Las tres carpetas se pueblan en los pasos siguientes de la sub-ola 9.1. Este primer
commit sólo fija la estructura base, el README y el \`.gitignore\`.

## Frontera de secretos

El kernel **nace sin secretos por diseño**. El mecanismo de carga de credenciales
vive del lado del motor como *mecanismo*, pero los valores, nombres y scopes de las
credenciales viven **del lado del adaptador de producto** (brokering host→kernel),
nunca embebidos acá. Este README y toda la estructura usan **placeholders genéricos**
únicamente: sin valores, sin nombres/paths reales de credenciales, endpoints, ARNs,
bucket names, project ids ni tokens.

## Escaneo de secretos del commit 1 (equivalencia con el plan de migración §3.3)

El plan de migración del producto (\`docs/pipeline/kernel-migration-plan.md §3.3\`)
define el escaneo de secretos como **precondición fail-closed** del primer commit:
escaneo verde → frontera de secretos confirmada → commit 1. Ese plan menciona
\`gitleaks\` y \`trufflehog\` como herramientas de referencia.

**Decisión de tooling (opción a):** el escaneo del commit 1 se ejecutó con el
**mismo escáner fail-closed del runtime del pipeline** (la primitiva \`sanitize()\`
compartida, que cubre las familias de secretos que aplican al proyecto:
proveedores de IA, AWS, GitHub, JWT, passwords, private keys). Es **equivalente**
a \`gitleaks\`/\`trufflehog\` para el alcance de un repo que nace vacío y sin secretos:
se itera **todo** el staging y cualquier match — o cualquier error del escáner —
**bloquea** el commit ("no pudo correr" ≠ "verde"). Instalar \`gitleaks\` es una
alternativa de paridad literal, no requerida para este commit.

La evidencia del run en verde se adjunta en el PR del issue #4662.
`;

function writeFileSafe(dest, rel, content) {
    const full = path.join(dest, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
}

function scaffold(dest) {
    if (fs.existsSync(dest)) {
        const entries = fs.readdirSync(dest).filter((e) => e !== '.git');
        if (entries.length > 0) {
            throw new Error(`El destino ${dest} no está vacío — el kernel nace sin historia heredada.`);
        }
    }
    fs.mkdirSync(dest, { recursive: true });

    const staged = [];
    for (const d of KERNEL_DIRS) {
        staged.push(writeFileSafe(dest, path.join(d, '.gitkeep'), ''));
    }
    staged.push(writeFileSafe(dest, 'README.md', README));
    staged.push(writeFileSafe(dest, '.gitignore', GITIGNORE));
    return staged;
}

module.exports = { scaffold, KERNEL_DIRS, GITIGNORE, README };

if (require.main === module) {
    const dest = process.argv[2];
    if (!dest) {
        process.stderr.write('Uso: node bootstrap-kernel.js <destino>\n');
        process.exit(2);
    }
    const staged = scaffold(dest);
    process.stdout.write(`Staging del kernel materializado en ${dest}:\n`);
    for (const f of staged) process.stdout.write(`  + ${path.relative(dest, f)}\n`);

    // Precondición fail-closed: escaneo ANTES de sugerir commit.
    try {
        const { scanned } = assertClean(staged);
        process.stdout.write(`\nEscaneo de secretos: VERDE (${scanned.length} archivos). Habilitado para commit 1.\n`);
        process.stdout.write(`Siguiente paso (manual, con OK): cd ${dest} && git init && git add -A && git commit && gh repo create intrale/kernel --private --source=. --push\n`);
        process.exit(0);
    } catch (e) {
        process.stderr.write(`\n${e.message}\n`);
        process.exit(1);
    }
}
