# 🔓 Salida de Blocked (desbloqueo)

Los demás módulos documentan **cómo se entra** a Blocked. Este módulo documenta
**quién** saca un issue de Blocked y **cómo**. En el pipeline V3 (filesystem-based,
gestionado por el Pulpo) existen **dos tipos de bloqueo reales**, con mecanismos de
salida **distintos**. No confundirlos.

## 1. `blocked:dependencies` — destrabe automático

- **Carpeta de estado:** `bloqueado-dependencias/` (de la fase).
- **Quién destraba:** el **`brazoDesbloqueo`** del Pulpo (`.pipeline/pulpo.js`),
  que corre periódicamente (~cada 5 min). **Ningún actor manual** fuerza el destrabe.
- **Cómo:** lista issues `gh issue list --label blocked:dependencies --state open`,
  resuelve las dependencias declaradas en el body/comentarios del issue
  (`resolveDependencies`), y **cuando TODAS las dependencias están CLOSED** quita el
  label `blocked:dependencies` y reingresa los archivos a la cola — el issue
  reentra solo, sin intervención.
- **`rev`:** **no se incrementa** (el bloqueo por dependencias no es un rebote de
  calidad; es una espera).
- **Fail-closed:** si no puede parsear las dependencias (respuesta no-JSON de `gh`,
  deps ambiguas), **mantiene el bloqueo** y salta el ciclo. Nunca destraba "por las
  dudas".

## 2. `needs-human` — solo intervención humana

- **Carpeta de estado:** `bloqueado-humano/` (de la fase).
- **Quién destraba:** **únicamente un humano**, de forma explícita. Causas típicas:
  aprobación pendiente, credencial faltante, decisión de negocio, **circuit breaker**
  tras 3 rebotes, o **cuarentena** por work-file corrupto.
- **Cómo:** el humano resuelve la causa y **remueve el label `needs-human`** /
  cierra el marker. Recién entonces el issue puede reingresar al flujo.
- **Autorización (control crítico):** **ningún agente automático puede
  auto-remover `needs-human`**. Auto-removerlo anularía el control humano que este
  gate existe para garantizar.

## Convención de rebote estructurado

El clasificador de rebotes asigna el tipo de bloqueo según la categoría:

| `rebote_categoria` | Label aplicado | Carpeta | Salida |
|--------------------|----------------|---------|--------|
| `dependency_block` | `blocked:dependencies` | `bloqueado-dependencias/` | automática (brazoDesbloqueo, deps CLOSED) |
| `human_block` | `needs-human` | `bloqueado-humano/` | manual (humano remueve label) |

> **Semántica:** los labels (`blocked:dependencies`, `needs-human`) viven en GitHub;
> las carpetas (`bloqueado-dependencias/`, `bloqueado-humano/`) son el **estado real
> del pipeline V3 en el filesystem**, gestionado por el Pulpo. Este módulo describe
> el comportamiento **verificado** de `.pipeline/pulpo.js` (`brazoDesbloqueo`,
> `resolveDependencies`, fail-closed), no un flujo idealizado.
