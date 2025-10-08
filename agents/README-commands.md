# Comandos básicos para Codex (lenguaje natural)

Estos comandos están alineados con nuestras reglas: PRs desde `develop`, ramas `codex/<issue>-<slug>`, y estados del Project V2: **Backlog, Refined, Todo, In Progress, Ready, Done, Blocked**.

---

## 1) Crear una historia y agregarla al tablero
**Instrucción:**
> Crear una issue en el repo **{owner}/{repo}**, agregarla al **GitHub Projects (V2) “Intrale” nº {1}** en la columna **“Backlog”**.  
> **Título:** {Título de la historia} · **Labels:** {lista} · **Assignees:** {lista}  
> **Cuerpo (markdown):**  
> {texto}

---

## 2) Mover una historia de estado (Project V2)
Usar exactamente estos nombres: **Backlog, Refined, Todo, In Progress, Ready, Done, Blocked**.

**Instrucciones:**
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “Backlog”**.
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “Refined”**.
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “Todo”**.
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “In Progress”**.
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “Ready”**.
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “Done”**.
- Mover la **issue #{N}** del repo **{owner}/{repo}** al **Status = “Blocked”** y comentar el motivo: {causa técnica}.

---

## 3) Crear PR correcto desde `develop` (una rama por issue)
**Instrucción:**
> Para la **issue #{N}** en **{owner}/{repo}**:
> 1) Crear rama **`codex/{N}-{slug-del-título}`** **desde `origin/develop`**.
> 2) Hacer un **commit mínimo**: {descripción breve}.
> 3) Abrir **PR contra `develop`** con título: `[auto] {título} (Closes #{N})`.
> 4) Asignar el PR a **leitolarreta** y devolver los links.

---

## 4) Refinar historias (Backlog → Refined)
**Instrucciones:**
- **Refinar la issue #{N}** del repo **{owner}/{repo}**: completar **Objetivo, Contexto, Cambios requeridos, Criterios de aceptación, Notas técnicas**, y **mover a “Refined”**.
- **Refinar todas las historias en Backlog** del Project **“Intrale” nº {1}** y dejarlas en **“Refined”** con la plantilla estándar.

---

## 5) Documentación (sin tocar código)
**Instrucción:**
> **Crear/actualizar documentación** en `docs/` para la **issue #{N}** del repo **{owner}/{repo}**, abrir **PR contra `develop`** con título `[auto][docs] {título} (Closes #{N})` y dejar link en la issue.

---

## 6) Diagnóstico rápido
**Instrucciones:**
- **Listar los últimos 5 PRs** creados por **leitocodexbot** en **{owner}/{repo}** con **head.ref** y **base.ref**.
- **Confirmar** que la rama de la **issue #{N}** fue creada **desde `origin/develop`** y que el **PR apunta a `develop`**.

---

## 7) Agrupadores: Refinar (una o varias)

### 7.1 Refinar UNA historia
> **Refinar la issue #{N}** del repo **{owner}/{repo}**: completar **Objetivo, Contexto, Cambios requeridos, Criterios de aceptación, Notas técnicas** con la plantilla estándar y **mover a “Refined”**. Confirmá con link.

### 7.2 Refinar VARIAS historias por lista
> **Refinar las issues #{N1}, #{N2}, #{N3}** del repo **{owner}/{repo}**: para cada una, completar plantilla estándar y **mover a “Refined”**. Devolver resumen con links por issue.

### 7.3 Refinar TODO el Backlog (por prioridad)
> **Refinar todas las historias en “Backlog”** del Project **“Intrale” nº {1}** (en orden de prioridad): para cada issue, completar la plantilla estándar y **mover a “Refined”**. Entregar listado de issues procesadas y las que quedaron pendientes.

---

## 8) Agrupadores: Desarrollar (una o varias)

> Regla: **siempre** crear rama desde `origin/develop` con formato `codex/{N}-{slug}`, abrir PR **contra `develop`**, título `[auto] {título} (Closes #{N})`, asignado a **leitolarreta**. No hacer merge.

### 8.1 Desarrollar UNA historia
> **Desarrollar la issue #{N}** en **{owner}/{repo}**:
> 1) Mover a **“In Progress”**.
> 2) Crear rama **`codex/{N}-{slug}`** desde `origin/develop`.
> 3) Implementar lo mínimo para cumplir criterios de aceptación (o lo indicado).
> 4) Abrir **PR a `develop`** con `[auto] {título} (Closes #{N})`, asignar a **leitolarreta**.
> 5) **Mover a “Ready”** y devolver links de rama y PR.

### 8.2 Desarrollar VARIAS historias por lista
> **Desarrollar las issues #{N1}, #{N2}, #{N3}** en **{owner}/{repo}**: por cada issue, aplicar los pasos del punto 8.1. Entregar tabla con estado final (rama, PR, estado).

### 8.3 Desarrollar las próximas K priorizadas en “Todo”
> **Desarrollar las próximas {K} historias en “Todo”** del Project **“Intrale” nº {1}** (según orden de prioridad): por cada issue, aplicar 8.1. Reportar progreso y links.

### 8.4 Finalizar desarrollo pendiente (reintentos de PR)
> **Para todas las issues en “In Progress”** del Project **“Intrale” nº {1}**: si falta PR, crear según 8.1; si ya hay PR, actualizar y **mover a “Ready”** cuando corresponda. Devolver resumen por issue.

---

## 9) Épicas (refinamiento y descomposición)

### 9.1 Crear una épica mínima
> Crear una **épica** en el repo **{owner}/{repo}**, agregarla al **Projects (V2) “Intrale” nº {1}** en **Backlog**.  
> **Título:** {título de la épica} · **Labels:** epic  
> **Cuerpo (markdown):** descripción breve del alcance y objetivo de alto nivel.

### 9.2 Refinar UNA épica (descomponer en historias)
> **Refinar la épica #{E}** del repo **{owner}/{repo}**:
> 1) Proponer la **descomposición** en historias hijas (lista).
> 2) **Crear cada historia hija** con la plantilla estándar (Objetivo, Contexto, Cambios requeridos, Criterios de aceptación, Notas técnicas).
> 3) Agregar **cada hija** al Projects “Intrale” nº {1} en **Backlog**, con label `epic-child`.
> 4) **Vincular** la épica con sus hijas usando una checklist en el cuerpo de la épica:
     >    - `[ ] #{H1} - {título}`
>    - `[ ] #{H2} - {título}`
> 5) **Mover la épica a “Refined”** y devolver links (épica + hijas).

### 9.3 Refinar VARIAS épicas por lista
> **Refinar las épicas #{E1}, #{E2}, #{E3}** en **{owner}/{repo}** siguiendo el proceso de 9.2.  
> Entregar resumen con links a cada épica y sus historias hijas creadas.

### 9.4 Agregar nuevas historias a una épica existente
> **Agregar historias hijas** a la **épica #{E}** (repo **{owner}/{repo}**) a partir de esta lista:
> - {Historia 1}
> - {Historia 2}  
    > Para cada una: crear issue hija con la plantilla estándar, agregar al Project en **Backlog**, label `epic-child`, y **añadir a la checklist** de la épica.

### 9.5 Sincronizar progreso de una épica
> **Sincronizar la épica #{E}** (repo **{owner}/{repo}**) con el estado de sus historias hijas:
> - **Marcar** la checklist de la épica `[x]` cuando una hija esté **Done**.
> - Si alguna hija está **In Progress**, mover la épica a **In Progress**.
> - Si **todas las hijas** están **Done**, mover la épica a **Done** y comentar un **resumen de cierre** con enlaces.

### 9.6 Convertir checklist en historias (épica con solo título)
> Para la **épica #{E}** que solo tiene título/alcance:
> 1) Leer la sección “Alcance / To-do” (bullets).
> 2) **Crear una historia hija por bullet**, con plantilla estándar.
> 3) Agregar cada hija al Project en **Backlog**, label `epic-child`.
> 4) Reemplazar los bullets por una **checklist enlazada** `[ ] #{H} - título`.
> 5) Mover la épica a **Refined** y devolver links.

### 9.7 Cerrar una épica cuando todo está completado
> Si **todas las historias hijas** de la **épica #{E}** están **Done**:
> - Mover la **épica** a **Done**.
> - Comentar un **informe de cierre** con: lista de hijas, fechas, y enlaces a los PRs correspondientes.
