# Comandos básicos para Codex (lenguaje natural) — intrale/platform

Estos comandos están alineados con nuestras reglas: PRs desde `develop`, ramas `codex/<issue>-<slug>`, y estados del Project V2: **Backlog, Refined, Todo, In Progress, Ready, Done, Blocked**. Se aplican al repo **intrale/platform** y al Project **“Intrale” nº 1**.

> **Frase canónica (refinamiento) — usar exactamente esta:**
> **Refinar la issue #<N> del repo intrale/platform escribiendo el detalle en el CUERPO de la issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejala en Refined.**

---

## 1) Crear una historia y agregarla al tablero
**Prompt:**
> Crear una issue en el repo **intrale/platform**, agregarla al **GitHub Projects (V2) “Intrale” nº 1** en la columna **“Backlog”**.  
> **Título:** {Título de la historia} · **Labels:** {lista} · **Assignees:** {lista}  
> **Cuerpo (markdown):**  
> {texto}

---

## 2) Mover una historia de estado (Project V2)
Usar exactamente estos nombres: **Backlog, Refined, Todo, In Progress, Ready, Done, Blocked**.

**Prompts:**
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “Backlog”**.
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “Refined”**.
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “Todo”**.
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “In Progress”**.
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “Ready”**.
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “Done”**.
- Mover la **issue #{N}** del repo **intrale/platform** al **Status = “Blocked”** y comentar el motivo: {causa técnica}.

---

## 3) Crear PR correcto desde `develop` (una rama por issue)
**Prompt:**
> Para la **issue #{N}** en **intrale/platform**:
> 1) Crear rama **`codex/{N}-{slug-del-título}`** **desde `origin/develop`**.
> 2) Hacer un **commit mínimo**: {descripción breve}.
> 3) Abrir **PR contra `develop`** con título: `[auto] {título} (Closes #{N})`.
> 4) Asignar el PR a **leitolarreta** y devolver los links.

---

## 4) Refinar historias (Backlog → Refined)
**Una (usar EXACTAMENTE esta frase):**
> **Refinar la issue #{N} del repo intrale/platform escribiendo el detalle en el CUERPO de la issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejala en Refined.**

**Varias (lista):**
> **Refinar las issues #{N1}, #{N2}, #{N3} del repo intrale/platform escribiendo el detalle en el CUERPO de cada issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejalas en Refined.**

**Backlog completo (prioridad):**
> **Refinar todas las historias en “Backlog” del Project “Intrale” nº 1 escribiendo el detalle en el CUERPO de cada issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejalas en Refined.**

---

## 5) Documentación (sin tocar código)
**Prompt:**
> **Crear/actualizar documentación** en `docs/` para la **issue #{N}** del repo **intrale/platform**, abrir **PR contra `develop`** con título `[auto][docs] {título} (Closes #{N})` y dejar link en la issue.

---

## 6) Diagnóstico rápido
**Prompts:**
- **Listar los últimos 5 PRs** creados por **leitocodexbot** en **intrale/platform** con **head.ref** y **base.ref**.
- **Confirmar** que la rama de la **issue #{N}** fue creada **desde `origin/develop`** y que el **PR apunta a `develop`**.

---

## 7) Agrupadores: Refinar (una o varias)

### 7.1 Refinar UNA historia (usar exactamente)
> **Refinar la issue #{N} del repo intrale/platform escribiendo el detalle en el CUERPO de la issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejala en Refined.**

### 7.2 Refinar VARIAS historias por lista
> **Refinar las issues #{N1}, #{N2}, #{N3} del repo intrale/platform escribiendo el detalle en el CUERPO de cada issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejalas en Refined.**

### 7.3 Refinar TODO el Backlog (por prioridad)
> **Refinar todas las historias en “Backlog” del Project “Intrale” nº 1 escribiendo el detalle en el CUERPO de cada issue (sobrescribí el cuerpo con la plantilla estándar). No crees ni modifiques archivos en docs/ ni publiques comentarios. Dejalas en Refined.**

---

## 8) Agrupadores: Desarrollar (una o varias)

> Regla: **siempre** crear rama desde `origin/develop` con formato `codex/{N}-{slug}`, abrir PR **contra `develop`**, título `[auto] {título} (Closes #{N})`, asignado a **leitolarreta**. No hacer merge.

### 8.1 Desarrollar UNA historia
> **Desarrollar la issue #{N}** en **intrale/platform**:
> - Mover la issue a **In Progress**.
> - Crear rama **`codex/{N}-{slug}`** desde `origin/develop`.
> - Implementar lo mínimo para cumplir criterios de aceptación (o lo indicado).
> - Abrir **PR a `develop`** con `[auto] {título} (Closes #{N})`, asignar a **leitolarreta**.
> - **Mover la issue a “Ready”** y devolver links de rama y PR.

### 8.2 Desarrollar VARIAS historias por lista
> **Desarrollar las issues #{N1}, #{N2}, #{N3}** en **intrale/platform**:
> - Para **cada** issue: mover a **In Progress**; crear rama **`codex/{N}-{slug}`** desde `origin/develop`; implementar lo mínimo; abrir **PR a `develop`** con `[auto] {título} (Closes #{N})`, asignar a **leitolarreta**; **mover a “Ready”**.
> - Entregar una **tabla** con: issue, rama, PR, estado final.

### 8.3 Desarrollar las próximas K priorizadas en “Todo”
> **Desarrollar las próximas {K} historias en “Todo”** del Project **“Intrale” nº 1** (según prioridad):
> - Para **cada** issue: mover a **In Progress**; crear rama **`codex/{N}-{slug}`** desde `origin/develop`; implementar lo mínimo; abrir **PR a `develop`** con `[auto] {título} (Closes #{N})`, asignar a **leitolarreta**; **mover a “Ready”**.
> - Devolver links y un **resumen** de progreso.

### 8.4 Finalizar desarrollo pendiente (reintentos de PR)
> **Para todas las issues en “In Progress”** del Project **“Intrale” nº 1**:
> - Si **no** existe PR: crear rama **`codex/{N}-{slug}`** desde `origin/develop`, hacer commit mínimo, abrir **PR a `develop`** con `[auto] {título} (Closes #{N})`, asignar a **leitolarreta**.
> - Si **ya hay** PR: actualizar con los cambios pendientes y **mover la issue a “Ready”** si cumple criterios.
> - Entregar una **tabla** con: issue, rama, PR, estado final.

---

## 9) Épicas (refinamiento y descomposición)

### 9.1 Crear una épica mínima
> Crear una **épica** en el repo **intrale/platform**, agregarla al **Projects (V2) “Intrale” nº 1** en **Backlog**.  
> **Título:** {título de la épica} · **Labels:** epic  
> **Cuerpo (markdown):** descripción breve del alcance y objetivo de alto nivel.

### 9.2 Refinar UNA épica (descomponer en historias)
> **Al refinar la épica, escribir el detalle en el CUERPO de la issue de la épica (sobrescribí el cuerpo con la plantilla estándar). No crear/modificar `docs/` ni publicar comentarios.**
> - Proponer la **descomposición** en historias hijas (lista).
> - **Crear cada historia hija** con la plantilla estándar.
> - Agregar **cada hija** al Project “Intrale” nº 1 en **Backlog**, label `epic-child`.
> - **Vincular** la épica con sus hijas usando una checklist enlazada.
> - **Mover la épica a “Refined”** y devolver links (épica + hijas).

### 9.3 Refinar VARIAS épicas por lista
> **Refinar las épicas #{E1}, #{E2}, #{E3}** en **intrale/platform**:
> - Para **cada** épica: escribir el refinamiento en el **CUERPO**; proponer historias hijas; crear cada hija con plantilla estándar; agregarlas al Project en **Backlog** (label `epic-child`); vincular mediante checklist; **mover la épica a “Refined”**.
> - Devolver links a épicas e hijas.

### 9.4 Agregar nuevas historias a una épica existente
> **Agregar historias hijas** a la **épica #{E}** en **intrale/platform** a partir de esta lista:
> - {Historia 1}
> - {Historia 2}  
    > Para cada historia: **crear issue hija** con la plantilla estándar, **agregar al Project** en **Backlog** con label `epic-child`, y **añadirla a la checklist** de la épica.

### 9.5 Sincronizar progreso de una épica
> **Sincronizar la épica #{E}** con el estado de sus historias hijas:
> - Marcar `[x]` en la checklist cuando una hija esté **Done**.
> - Si alguna hija está **In Progress**, mover la épica a **In Progress**.
> - Si **todas** las hijas están **Done**, mover la épica a **Done** y comentar un **resumen de cierre**.

### 9.6 Convertir checklist en historias (épica con solo título)
> Para la **épica #{E}** que solo tiene título/alcance:
> - Leer la sección “Alcance / To-do” (bullets).
> - **Crear una historia hija por bullet** con la plantilla estándar.
> - Agregar cada hija al Project en **Backlog**, label `epic-child`.
> - Reemplazar los bullets por una **checklist enlazada** en la épica.
> - Mover la épica a **Refined** y devolver links.

### 9.7 Cerrar una épica cuando todo está completado
> Si **todas las hijas** de la **épica #{E}** están **Done**:
> - Mover la **épica** a **Done**.
> - Comentar un **informe de cierre** con lista de hijas, fechas y enlaces a PRs.
