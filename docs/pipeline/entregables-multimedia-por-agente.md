# Entregables multimedia por agente

> **Fase 1 — Relevamiento y mapeo (issue #3891).** Este documento es la fuente
> de verdad de "qué artefacto multimedia produce cada skill, en qué fase, dónde
> lo deja y cómo se envía al operador del pipeline vía Telegram (directo) o
> Google Drive (link)". No introduce código runtime: el único entregable de este
> issue es este `.md`. La **Fase 2** (implementar cada brecha) se desglosa
> después (ver §4 y §6).
>
> **Cómo se verificó:** todas las rutas y tipos de la tabla se tomaron
> **literal** del código productivo, no se inventaron. Fuentes auditadas:
> - `.pipeline/lib/skill-deliverable-attachments.js` — recolector que escanea el
>   filesystem por skill+issue y devuelve `[{ type, path, descriptor }]`. Es el
>   **catálogo `SKILL_SOURCES`** el que define qué rutas conoce el pipeline.
> - `.pipeline/lib/deliverable-notify.js` — notificador que arma el payload
>   Telegram (text|photo|document|video|animation) y aplica la allowlist de path
>   (CA-SEC-1).
> - `qa/scripts/qa-video-share.js` — sharing de Drive para videos pesados.
> - `.pipeline/servicio-drive.js` — consume la cola `.pipeline/servicios/drive/pendiente/`.

---

## 0. Glosario de columnas (para que cualquier skill futuro rellene la tabla sin ambigüedad)

| Columna | Significado |
|---------|-------------|
| **Skill** | Nombre del skill/agente (ej. `ux`, `security`). |
| **Fase** | Fase del pipeline en la que el agente produce el artefacto (`definición`, `criterios`, `plan técnico`, `dev`, `build`, `verificación/QA`, `aprobación/review`). |
| **Tipo entregable** | Qué representa el artefacto para el operador (mockup, criterios, plan, análisis, reporte, evidencia…). |
| **Artefacto** | Formato del archivo (PNG, PDF, MP4, MD, HTML…). |
| **Ruta esperada** | Directorio **literal** donde el recolector `skill-deliverable-attachments.js` busca. SIEMPRE issue-scoped con `{issue}`. Si el skill produce algo fuera de una ruta conocida → es brecha de **productor**. |
| **Tipo notif** | `type` que recibe `deliverable-notify`: `image` \| `document` \| `video` \| `animation`. Debe coincidir con el `type` del perfil del recolector. |
| **Envío** | `Directo (photo/document/video)` a Telegram, o `Drive (link)` para artefactos pesados. |
| **Sensibilidad** | `público` \| `interno` \| `confidencial` (regla R1, ver §5). Determina el canal permitido. |
| **Brecha** | `—` (conectado) \| `productor` (no deja el archivo en ruta conocida) \| `notificador` (no busca / no notifica ese skill) \| `conexión` (no encola a Drive). |

**Fuente de verdad de rutas conocidas** (perfiles reales de `SKILL_SOURCES` en
`skill-deliverable-attachments.js`):

| Perfil (skill) | `dirTemplate` real | `type` | Formatos |
|----------------|--------------------|--------|----------|
| `ux` caso A | `.pipeline/assets/mockups/{issue}` | `image` | `.png .jpg .jpeg .gif` |
| `ux` caso B | `qa/evidence/{issue}` | `image` | `.png .jpg .jpeg .gif` |
| `ux` legacy plano | `.pipeline/assets/mockups` (filename DEBE incluir `{issue}`) | `image` | `.png .jpg .jpeg .gif` |
| `ux` video | `qa/evidence/{issue}` | `video` | `.mp4 .webm` |
| `po` | `.pipeline/assets/docs/{issue}` | `document` | `.pdf .md` |
| `guru` | `.pipeline/assets/docs/{issue}` | `document` | `.pdf .md` |
| `planner` | `.pipeline/assets/docs/{issue}` | `document` | `.pdf .md .png .svg` (todos enviados como `document`) |
| `cua` | `.pipeline/cua-outputs/{issue}` | inferido por extensión | `.png .mp4 .pdf` |

> ⚠️ **Solo estos 5 skills (`ux`, `po`, `guru`, `planner`, `cua`) tienen perfil
> de recolección.** Cualquier otro skill que produzca multimedia hoy **no es
> encontrado** por el recolector → brecha de productor (§4).
>
> ⚠️ **Roots por tipo del notificador** (`DEFAULT_ATTACHMENT_ROOTS` en
> `deliverable-notify.js`): `document → .pipeline/assets/docs`,
> `image → .pipeline/assets/mockups`, `video → .pipeline/assets/videos`,
> `animation → .pipeline/assets/animations`. Notar que `video` apunta a
> `.pipeline/assets/videos` **pero ningún perfil del recolector deja videos
> ahí** (el único perfil de video es `qa/evidence/{issue}`) → ver brecha de
> conexión (§4).
>
> ⚠️ **Subset notificable** (`DEFAULT_NOTIFY_SKILLS`): `['guru','po','ux','planner']`.
> Aunque un skill deje el archivo en ruta conocida, si **no está en este subset**
> el pulpo no dispara la notificación de entregable parcial → brecha de
> notificador para `qa`, `security`, `tester`, etc.

---

## 1. Tabla resumen

| Skill | Fase | Tipo entregable | Artefacto | Ruta esperada | Tipo notif | Envío | Sensibilidad | Brecha |
|-------|------|-----------------|-----------|---------------|-----------|-------|--------------|--------|
| **ux** | definición / criterios | Mockup | PNG (JPG/GIF) | `.pipeline/assets/mockups/{issue}/` | `image` | Directo (`photo`) | público | — |
| **po** | criterios / refinamiento | Criterios de aceptación | PDF / MD | `.pipeline/assets/docs/{issue}/` | `document` | Directo (`document`) | interno | — |
| **planner** | planificación | Plan / diagrama de tareas | PDF / MD (PNG/SVG enviados como doc) | `.pipeline/assets/docs/{issue}/` | `document` | Directo (`document`) | interno | — |
| **guru** | análisis técnico | Informe de análisis | PDF / MD | `.pipeline/assets/docs/{issue}/` | `document` | Directo (`document`) | interno | — |
| **architect** | criterios / plan técnico | Informe de arquitectura (diagramas) | PDF / MD | `.pipeline/assets/docs/{issue}/` *(ruta reusada de `document`)* | `document` | Directo (`document`) | interno | **productor** (sin perfil propio en `SKILL_SOURCES`) |
| **backend-dev** | dev | — (produce código Kotlin) | — | — | — | — | N/A | — |
| **android-dev** | dev | Screenshot opcional de verificación | PNG | `qa/evidence/{issue}/` *(ruta de `ux`)* | `image` | Directo (`photo`) | interno | **productor** (sin perfil `android-dev`; depende del perfil `ux`) |
| **web-dev** | dev | — (produce código Kotlin/Wasm) | — | — | — | — | N/A | — |
| **tester** | tester | Reporte de cobertura Kover | HTML (idealmente PDF/MD) | `.pipeline/assets/docs/{issue}/` | `document` | Directo (`document`) | interno | **productor** (sin perfil + HTML no está en formatos soportados) |
| **qa** | verificación / QA E2E | Video de ejecución E2E | MP4 / WEBM | `qa/evidence/{issue}/` | `video` | **Drive (link)** — pesado | confidencial | **conexión** (no encola a Drive) + **notificador** (no está en subset notificable) |
| **qa** | verificación / QA E2E | Reporte de QA | PDF | `.pipeline/assets/docs/{issue}/` | `document` | Directo (`document`) | confidencial | **productor** (sin perfil `qa`) + **notificador** |
| **security** | aprobación / security review | Reporte OWASP de findings | PDF / MD | `.pipeline/assets/docs/{issue}/` | `document` | **Directo (`document`) — NUNCA link público de Drive (R2)** | confidencial | **productor** (sin perfil `security`) + **notificador** |
| **builder** | build | Screenshot/recorte de logs de build | PNG | `.pipeline/assets/mockups/{issue}/` *(ruta de `image`)* | `image` | Directo (`photo`) | interno | **productor** (sin perfil `builder`) + **notificador** |
| **cua** | comandos CUA | Output de comando (captura/video/doc) | PNG / MP4 / PDF | `.pipeline/cua-outputs/{issue}/` | inferido por extensión | Directo o Drive según tipo | interno | **conexión** (videos sin encolar a Drive) |
| **reset** | operación | — | — | — | — | — | N/A | — |
| **ops** | operación | — | — | — | — | — | N/A | — |
| **ghostbusters** | operación | — | — | — | — | — | N/A | — |
| **ios-dev** | dev | — | — | — | — | — | N/A — congelado | — |
| **desktop-dev** | dev | — | — | — | — | — | N/A — congelado | — |

> Skills auditados con producción real o potencial de multimedia (CA ≥12):
> `ux, po, planner, guru, architect, backend-dev, android-dev, web-dev, tester,
> qa, security, builder` (= 12) + `cua` (perfil existente) + `reset, ops,
> ghostbusters` (N/A) + `ios-dev, desktop-dev` (N/A — congelados).

---

## 2. Sección por skill

### 2.1 `ux` — 🎨 mockups y evidencia visual ✅ conectado
- **Produce:** PNG de mockups/diseños en definición; PNG de evidencia (Android) en verificación; opcionalmente videos cortos.
- **Dónde:** `.pipeline/assets/mockups/{issue}/` (mockups) y `qa/evidence/{issue}/` (evidencia/video). Ambos perfiles existen en `SKILL_SOURCES.ux`.
- **Envío:** imágenes → Telegram `photo` directo. Es el camino feliz: si el archivo está en la ruta, llega solo.
- **Sensibilidad:** `público` (mockups de UI no exponen datos sensibles).
- **Orden de lectura:** el recolector ordena `actual → esperado → narrativa` (CA-UX-7) para que el operador entienda el "antes/después".
- **Brecha:** ninguna para imágenes. Para videos en `qa/evidence/{issue}/` ver brecha de conexión (Drive).

### 2.2 `po` — 📋 criterios de aceptación ✅ conectado
- **Produce:** documento con criterios refinados (PDF o MD).
- **Dónde:** `.pipeline/assets/docs/{issue}/`. Perfil `SKILL_SOURCES.po` existe.
- **Envío:** Telegram `document` directo.
- **Sensibilidad:** `interno` (criterios de negocio; no se publican fuera del chat privado).
- **Brecha:** ninguna a nivel infra. Depende de que el agente PO efectivamente escriba el `.pdf/.md` en esa ruta (hoy lo deja como comentario en el issue, no como archivo → en la práctica suele no haber adjunto, pero la ruta está soportada).

### 2.3 `planner` — 🗺️ plan / diagrama de tareas ✅ conectado
- **Produce:** plan con dependencias / Gantt; el perfil acepta `.pdf .md .png .svg` pero **todos se envían como `document`** (no como imagen).
- **Dónde:** `.pipeline/assets/docs/{issue}/`. Perfil `SKILL_SOURCES.planner` existe.
- **Envío:** Telegram `document` directo.
- **Sensibilidad:** `interno`.
- **Nota:** si el planner generara un PNG del Gantt y quisiera enviarlo como `photo`, hoy se enviaría como `document` (porque el `type` del perfil es fijo `document`). Mejora menor, no brecha bloqueante.

### 2.4 `guru` — 🔍 informe de análisis técnico ✅ conectado
- **Produce:** informe de análisis/arquitectura (PDF o MD).
- **Dónde:** `.pipeline/assets/docs/{issue}/`. Perfil `SKILL_SOURCES.guru` existe.
- **Envío:** Telegram `document` directo.
- **Sensibilidad:** `interno`.
- **Brecha:** ninguna a nivel infra (mismo caveat que PO: hoy guru comenta en el issue en vez de dejar archivo).

### 2.5 `architect` — 🏛️ informe de arquitectura ⚠️ brecha productor
- **Produce (potencial):** informe PDF con diagramas de arquitectura y flujo en la fase de criterios/plan técnico.
- **Dónde debería:** `.pipeline/assets/docs/{issue}/` (reusa el root `document`).
- **Brecha:** **no existe perfil `architect` en `SKILL_SOURCES`** → aunque dejara el PDF en la ruta, `collectAttachmentsForSkill('architect', …)` devuelve `[]`. Además `architect` no está en `DEFAULT_NOTIFY_SKILLS`. **Esfuerzo: Simple** (agregar perfil reusando el de `guru/po`).
- **Sensibilidad:** `interno`.

### 2.6 `backend-dev` — N/A
- **Produce:** código Kotlin (backend Ktor), tests. No genera multimedia destinada al operador.
- **Brecha:** ninguna — N/A.

### 2.7 `android-dev` — 📱 screenshots opcionales ⚠️ brecha productor
- **Produce (potencial):** screenshots de verificación de UI durante dev.
- **Dónde debería:** `qa/evidence/{issue}/` (root `image`).
- **Brecha:** no hay perfil `android-dev`; sólo `ux` mira `qa/evidence/{issue}/`. Si el android-dev deja un PNG ahí, sólo se notificaría si la notificación se dispara como `ux`. **Esfuerzo: Simple.**
- **Sensibilidad:** `interno`.
- **Nota:** la generación del APK es responsabilidad del `builder`, no del android-dev.

### 2.8 `web-dev` — N/A
- **Produce:** código Kotlin/Wasm, PWA. No genera multimedia para el operador en su flujo normal.
- **Brecha:** ninguna — N/A.

### 2.9 `tester` — 🧪 reporte de cobertura Kover ⚠️ brecha productor + formato
- **Produce:** reporte de cobertura Kover, típicamente **HTML**.
- **Dónde debería:** `.pipeline/assets/docs/{issue}/`.
- **Brecha doble:** (a) **no existe perfil `tester`** en `SKILL_SOURCES`; (b) el perfil `document` sólo acepta `.pdf .md`, **HTML no está soportado** (el notificador difiere HTML a V2 por requerir DOMPurify+jsdom — ver #3547). El tester debería exportar a PDF, o registrar un perfil que acepte el resumen como MD. **Esfuerzo: Medio.**
- **Sensibilidad:** `interno`.

### 2.10 `qa` — 🎬 video E2E + 📄 reporte ⚠️ brecha conexión + notificador
- **Produce:** video MP4/WEBM de la ejecución E2E (pesado, hasta minutos) y opcionalmente un reporte PDF.
- **Dónde:** video en `qa/evidence/{issue}/` (el perfil `ux` lo cubre como `video`); reporte PDF en `.pipeline/assets/docs/{issue}/`.
- **Brechas:**
  1. **Conexión (Drive):** los videos exceden el límite práctico de Telegram (50 MB / cap de duración 300 s vía `probeVideoDurationSeconds`). Deberían **subirse a Drive** (`qa/scripts/qa-video-share.js` + cola `.pipeline/servicios/drive/pendiente/`) y enviarse como **link**, no como binario. Hoy ese flujo productor→notificador→Drive **no está conectado**: el notificador intenta el binario directo. **Esfuerzo: Medio.**
  2. **Notificador:** `qa` no está en `DEFAULT_NOTIFY_SKILLS` ni tiene perfil propio en `SKILL_SOURCES` (sólo se cubre porque `ux` mira `qa/evidence/{issue}/`). **Esfuerzo: Simple.**
- **Sensibilidad:** `confidencial` — un video E2E puede mostrar credenciales/JWT/PII en pantalla (R4). Por eso, si va a Drive, debe ser con permiso **restringido**, no `anyone with link` (R3).

### 2.11 `security` — 🔒 reporte OWASP ⚠️ brecha productor + regla de seguridad crítica
- **Produce:** reporte de findings OWASP (PDF o MD) en la fase de security review.
- **Dónde debería:** `.pipeline/assets/docs/{issue}/` — **ruta REAL existente** (root `document`).
  > ⚠️ **Corrección verificada:** el CA original del issue proponía
  > `.pipeline/assets/reports/security/{issue}/`. Esa ruta **NO existe** como dir
  > de búsqueda del notificador (no hay perfil `reports`/`security` en
  > `SKILL_SOURCES`, confirmado por lectura del catálogo). El doc usa la ruta
  > real `.pipeline/assets/docs/{issue}/`. Crear un perfil `security` dedicado se
  > registra como **brecha de productor explícita** (§4), no se asume existente.
- **Envío:** **`document` directo al chat privado de Telegram. NUNCA por link público de Drive (R2).** Publicar un mapa de vulnerabilidades explotables en una URL sin auth es A01 (Broken Access Control). Si el PDF excede el límite de Telegram, usar Drive con permiso **restringido** (`type: user`/`domain`), nunca `anyone`.
- **Sensibilidad:** `confidencial`.
- **Brecha:** no existe perfil `security` en `SKILL_SOURCES` ni está en el subset notificable. **Esfuerzo: Medio** (perfil + enforcement de "nunca público").

### 2.12 `builder` — 🏗️ screenshot/recorte de logs ⚠️ brecha productor
- **Produce (potencial):** screenshot o recorte de los logs de build (éxito/fallo), PNG.
- **Dónde debería:** `.pipeline/assets/mockups/{issue}/` (root `image`).
- **Brecha:** no existe perfil `builder`; no está en subset notificable. **Esfuerzo: Simple.**
- **Sensibilidad:** `interno` (logs de build pueden exponer rutas internas; no publicar).

### 2.13 `cua` — ⚙️ outputs de comandos ✅ perfil existe / ⚠️ conexión videos
- **Produce:** capturas, videos o documentos de la ejecución de comandos CUA.
- **Dónde:** `.pipeline/cua-outputs/{issue}/`. Perfil `SKILL_SOURCES.cua` existe con `type` **inferido por extensión** (`.png→image`, `.mp4→video`, `.pdf→document`).
- **Brecha:** los `.mp4` caen en la misma brecha de conexión a Drive que `qa` (no se encolan). **Esfuerzo: Medio** (compartido con la brecha de qa).
- **Sensibilidad:** `interno`.

### 2.14 `reset` / `ops` / `ghostbusters` — N/A
- Operación/mantenimiento del entorno. No producen artefactos multimedia destinados al operador como entregable de issue. Marcados `N/A` para evitar brechas fantasma.

### 2.15 `ios-dev` / `desktop-dev` — N/A — congelados
- Skills congelados (ver `frozen-skills.md`). No se auditan brechas porque no se ejecutan. Si se reactivan, heredarían el comportamiento de `android-dev` (screenshots → `qa/evidence/{issue}/`).

---

## 3. Diagrama de flujo

```
                  ┌─────────────────────────────────────────────┐
   AGENTE         │ produce artefacto durante su fase            │
  (ux/po/...)     │   PNG / PDF / MP4 / MD ...                   │
                  └───────────────────┬─────────────────────────┘
                                      │ deja el archivo en…
                                      ▼
        ┌──────────────────────────────────────────────────────────┐
        │ RUTA CONOCIDA issue-scoped (SKILL_SOURCES)                │
        │  .pipeline/assets/mockups/{issue}/   (image)             │
        │  .pipeline/assets/docs/{issue}/      (document)          │
        │  qa/evidence/{issue}/                (image | video)     │
        │  .pipeline/cua-outputs/{issue}/      (inferido)          │
        └───────────────────┬──────────────────────────────────────┘
                            │ collectAttachmentsForSkill(skill, issue)
                            ▼
        ┌──────────────────────────────────────────────────────────┐
        │ deliverable-notify.resolveAttachments                    │
        │  · allowlist de root + rechazo de `..`/null-byte         │
        │    + fs.realpathSync          (CA-SEC-1)                 │
        │  · magic bytes + cap 50 MB / 5 adjuntos                  │
        │  · video: probeVideoDurationSeconds (cap 300 s)         │
        │  · sanitizeTelegramPayload (filename/caption, #2334)     │
        └───────────────────┬───────────────────┬──────────────────┘
                            │                   │
            liviano/imagen  │                   │ pesado/video o confidencial
                            ▼                   ▼
        ┌──────────────────────────┐   ┌──────────────────────────────────┐
        │ Telegram DIRECTO         │   │ Google Drive                     │
        │  photo / document /      │   │  cola .pipeline/servicios/drive/ │
        │  video / animation       │   │  pendiente/  → servicio-drive.js │
        │  (chat privado)          │   │  · público → anyone w/ link      │
        └──────────────────────────┘   │  · ≥interno → permiso restringido│
                                       │  → caption con LINK descriptivo  │
                                       └──────────────────────────────────┘

  Orden de envío con varios adjuntos (ATTACHMENT_TYPE_ORDER):
     texto → image → document → video → animation
```

**Experiencia de recepción (guidelines UX, no bloqueantes para Fase 2):**
1. Caption descriptivo y consistente: `<emoji> <skill> · <fase> · #<issue> · <descriptor>` (ej. `🎨 UX · Definición · #3891 · mockup login`).
2. Iconografía estable por tipo (de `ATTACHMENT_TYPE_EMOJI`): 🖼️ imagen, 📄 documento, 🎬 video, 🎞️ animación. Por skill (`SKILL_EMOJIS`): 🔍 guru, 📋 po, 🎨 ux, 🗺️ planner, ⚙️ cua.
3. Agrupar adjuntos del mismo issue (coherente con el aislamiento `{issue}`).
4. En fallo de Drive: mensaje claro al operador con qué artefacto falló, no silencio (R6).
5. Links de Drive con texto descriptivo (`[Mockup login #3891](url)`), nunca la URL cruda.

---

## 4. Brechas identificadas

Clasificación: **productor** (el skill no deja el archivo en una ruta conocida del recolector) · **notificador** (el recolector/notificador no busca o no notifica ese skill) · **conexión** (el artefacto debería ir a Drive pero el notificador no lo encola).

| # | Skill / área | Tipo de brecha | Descripción | Prioridad | Esfuerzo |
|---|--------------|----------------|-------------|-----------|----------|
| B1 | `qa` (video E2E) | **conexión** | Videos `qa/evidence/{issue}/*.mp4` exceden Telegram; deben subirse a Drive (`qa-video-share.js` + cola drive) y enviarse como link. Hoy el notificador intenta binario directo y falla en silencio. | Alta | Medio |
| B2 | `cua` (video) | **conexión** | `.pipeline/cua-outputs/{issue}/*.mp4` misma situación que B1; comparte solución. | Media | Medio (comparte con B1) |
| B3 | `security` | **productor** + **notificador** | No existe perfil `security` en `SKILL_SOURCES`; el reporte OWASP no se recolecta. Debe usar `.pipeline/assets/docs/{issue}/` y enviarse `document` directo (R2, nunca Drive público). | Alta | Medio |
| B4 | `tester` | **productor** (+ formato) | No existe perfil `tester`; además el reporte Kover suele ser HTML, no soportado (sólo `.pdf .md`). Requiere exportar a PDF o resumen MD + perfil nuevo. | Media | Medio |
| B5 | `architect` | **productor** | No existe perfil `architect`; el informe de arquitectura no se recolecta. Reusar root `document`. | Media | Simple |
| B6 | `builder` | **productor** + **notificador** | No existe perfil `builder`; el screenshot de logs no se recolecta ni se notifica. | Baja | Simple |
| B7 | `android-dev` | **productor** | No existe perfil `android-dev`; screenshots de verificación dependen del perfil `ux` mirando `qa/evidence/{issue}/`. | Baja | Simple |
| B8 | notificador (global) | **notificador** | `DEFAULT_NOTIFY_SKILLS = ['guru','po','ux','planner']`. Skills como `qa`, `security`, `tester`, `architect`, `builder` no disparan notificación de entregable parcial aunque dejen el archivo. Ampliar el subset (vía `config.yaml`). | Alta | Simple |
| B9 | notificador (video root) | **conexión** | `DEFAULT_ATTACHMENT_ROOTS.video = '.pipeline/assets/videos'` pero **ningún perfil del recolector deja videos ahí** (el único es `qa/evidence/{issue}`). Inconsistencia a resolver junto con B1 (decidir root canónico de video o eliminar el huérfano). | Baja | Simple |
| B10 | productores doc (po/guru) | **productor** (operativo) | Hoy `po`/`guru` comentan en el issue en vez de **escribir un archivo** en `.pipeline/assets/docs/{issue}/`. La infra está lista; falta que el agente materialice el `.pdf/.md`. | Media | Simple |

> **Nota sobre el split de Fase 2:** el issue afirma que el pipeline V2 desglosa
> automáticamente cada brecha en sub-issues usando
> `docs/pipeline/brazo-desbloqueo.md` como referencia. **Ese archivo NO existe
> hoy en el repo** (verificado, `test -f` → MISSING). Por lo tanto **no se debe
> asumir que el split es automático**: si el mecanismo no está implementado, las
> brechas B1–B10 deben abrirse como issues manuales (con label de trazabilidad
> `follow-up:relevamiento-#3891`). Esta observación es deliberada (riesgo guru).

---

## 5. Reglas de seguridad (R1–R6, mismo nivel que los criterios de aceptación)

Estas reglas son **vinculantes** para el mapeo y para cualquier implementación de Fase 2.

- **R1 — Columna "Sensibilidad" obligatoria.** Cada artefacto se clasifica
  `público` / `interno` / `confidencial`. Determina el canal permitido (ver §1 y §0).
- **R2 — Reportes de `/security` y artefactos `confidencial` NUNCA por link
  público de Drive.** Se envían como `document` directo al chat privado de
  Telegram (no genera URL pública). Si exceden el límite de Telegram, Drive con
  permiso **restringido** (`type: user`/`domain`), nunca `anyone with link`.
  Publicar findings OWASP en URL sin auth es A01 (Broken Access Control).
- **R3 — Drive con permiso restringido como default para sensibilidad ≥ interno.**
  `anyone with link` (el comportamiento actual de `qa-video-share.js:459`,
  `{ type:'anyone', role:'reader' }`) queda **sólo** para artefactos `público`
  (ej. mockups de UX). Para `interno`/`confidencial` se requiere restringido.
- **R4 — La redacción de secrets es sólo metadata.** `sanitize-payload.js`
  redacta AWS keys, GitHub tokens, JWT, Google API keys y Telegram bot tokens
  **en filename y caption** (#2334), pero **NO inspecciona el contenido binario**
  (interior de PNG/MP4/PDF). El **productor es responsable** de no embeber
  secrets/PII en el artefacto (ej. QA debe enmascarar credenciales en pantalla
  antes de grabar el video E2E).
- **R5 — Preservar invariantes existentes en Fase 2.** Todo productor/conector
  nuevo debe mantener: allowlist de path bajo root permitido (CA-SEC-1),
  aislamiento por issue con `{issue}` (CA-1.4 / #3658) y redacción de
  filename/caption (#2334). **No regresar a globs sin `{issue}`.** Los perfiles
  legacy sin `{issue}` en `dirTemplate` (`.pipeline/assets/mockups`,
  `.pipeline/assets/docs`) son **rutas compartidas a evitar** para nuevos
  productores: exigen `{issue}` en el filename y no aíslan por directorio.
- **R6 — Fallo de Drive seguro.** Si la subida a Drive falla, **NO degradar** a
  enviar el binario crudo a Telegram saltándose la clasificación de sensibilidad.
  Reportar un fallo controlado al operador (qué artefacto, por qué), nunca un
  silencio ni un fallback inseguro.

---

## 6. Cómo usar este documento en Fase 2

1. Cada fila con `Brecha ≠ —` en §1 y cada entrada B1–B10 de §4 es candidata a
   una tarea de implementación independiente.
2. Antes de implementar, validar si existe el mecanismo de split automático
   (`docs/pipeline/brazo-desbloqueo.md`). Si no existe, abrir las brechas como
   issues manuales con `follow-up:relevamiento-#3891`.
3. Toda nueva ruta de productor debe declararse en `SKILL_SOURCES`
   (`skill-deliverable-attachments.js`) **issue-scoped con `{issue}`** y, si el
   tipo lo amerita, agregar el skill a `DEFAULT_NOTIFY_SKILLS` vía `config.yaml`.
4. Para artefactos pesados o `confidencial`, implementar el flujo a Drive
   respetando R2/R3/R6; reutilizar la cola `.pipeline/servicios/drive/pendiente/`
   sin reescribir `servicio-drive.js`.
5. No tocar runtime del notificador en este issue: **Fase 1 es sólo este
   documento.**
