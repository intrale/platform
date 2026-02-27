# 🌱 Nomenclatura de Ramas

Reglas:
- El nombre deriva del issue y su prefijo.
- Si el issue es sub-tarea, trabajar sobre la **misma rama** usada por el issue padre (heredar nomenclatura del padre).

Prefijos:
| Tipo            | Prefijo            |
|-----------------|--------------------|
| Funcionalidad   | feature/<desc>     |
| Corrección      | bugfix/<desc>      |
| Documentación   | docs/<desc>        |
| Refactorización | refactor/<desc>    |

**Regla de agentes IA**
- Las ramas creadas automáticamente **siempre** usan el formato **`agent/<issue>-<slug>`** y base **`origin/main`**.
- Los prefijos `feature/`, `bugfix/`, `refactor/`, `docs/` se reservan para trabajo **manual**.
