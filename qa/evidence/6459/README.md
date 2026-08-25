# Evidencia visual #6459

- `dashboard-huerfano.png`: captura del dashboard renderizado con una fila cuyo resultado es `huerfano`.
- Baseline acordada: `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`.
- Verificación visual: se observan el glifo `∅`, la etiqueta `huérfano` y el color rosa resuelto desde `--result-huerfano*`, distinto del badge rojo de `error`.

La captura se obtuvo sobre el HTML real generado por `dashboard.js`, con una fixture de logs recientes que incluye resultados `huerfano`, `ok`, `error` y un log sin metadata.
