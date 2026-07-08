## Reporte de auditoría de seguridad — issue #4531

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/4531-header-single-row` @ `9643ebf0b` — rediseño del
header común MIZPÁ del dashboard Node.js del pipeline. 10 archivos de vistas modificados
(`.pipeline/views/dashboard/*.js` + `theme.css`) + assets de mockup. Superficie OWASP
relevante: **A03 Injection → XSS DOM-based**, la restricción exacta del comment de security
de #4463 (SSR literal + hidratación por `.textContent`/`.classList`, sin `innerHTML` sobre el
slice de datos).

### Hallazgos

Sin hallazgos.

Verificación empírica realizada:

- **[A03 Injection — XSS DOM] SSR 100% literal** (`header-meta.js:54-68`,
  `renderHeaderMetaSsr`): las pills `#bld-status`, `#hdr-mode`, `#hdr-resources`,
  `#hdr-pulpo`, `#hdr-clock` usan placeholders fijos (`…`, `Build sin datos`). Sin
  interpolación de dato externo / slice / query-param.
- **[A03 Injection — XSS DOM] Hidratación sin `innerHTML` sobre el slice**
  (`header-meta.js:104-196`, `__hydrateHeaderPills`): la nueva pill de build (`#bld-status`)
  y la nueva pill de modo (`#hdr-mode`) se hidratan sólo con `textContent`, `classList`,
  `.title` (property) y `setAttribute('aria-label')`.
  - **Vector (criollo):** si un atacante lograra inyectar HTML en el nombre de rama o el
    hash de commit del build, sólo podría hacerlo ejecutable si ese dato terminara en un
    sink que renderiza HTML (`innerHTML`). Acá `d.build.branch`/`d.build.commit`
    (`header-meta.js:123-127`) sólo llegan a `.title` y `aria-label`, que muestran el texto
    literal sin ejecutarlo. No hay camino a `innerHTML`.
- **`grep` del diff (líneas agregadas, `*.js`)** de `innerHTML|outerHTML|insertAdjacentHTML|
  document.write|eval|new Function` → 0 sinks nuevos; sólo comentarios que los prohíben. Los
  `innerHTML` en `home.js`/`satellites.js` son preexistentes, fuera del diff.
- **Sanitización de entrada intacta** (`dashboard-slices.js:182-189`, `readBuildStatus`):
  `status` contra allowlist `{passing,failing,running,unknown}`, `branch.slice(0,80)`,
  `commit.slice(0,12)` con type-check. `dashboard-slices.js` / `dashboard-routes.js` /
  `build-status` **no fueron tocados** en esta rama → defensa en profundidad sin cambios
  respecto de la base aprobada.
- **[Secrets]** Sin secrets hardcodeados en el diff (sólo strings de UI, IDs de contrato y
  emojis).
- **[A06 Componentes vulnerables]** Sin cambios en manifests/locks; sin dependencias nuevas.
- **[A07 Auth]** No aplica: sin endpoints ni flujos de autenticación tocados.
- **Tests SEC-1** (`__tests__/header-meta.test.js`): 10/10 pass, incluyendo "el SSR no usa
  innerHTML ni interpola datos dinámicos" y "la hidratación compartida usa
  textContent/classList/title, nunca innerHTML".

Se preserva la restricción de seguridad de #4463. Sin hardening pendiente.

### Remediación

No aplica — sin hallazgos.

_— agente `security`, fase verificación_
