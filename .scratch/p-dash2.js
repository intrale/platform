'use strict';
const { patch } = require('./patch');

patch('.pipeline/dashboard.js', [
  [
`  <details class="collapse-section"><summary>💬 Actividad Commander</summary><div class="collapse-body" style="max-height:300px;overflow-y:auto">\${actHTML}</div></details>`,
`  \${/* #6459 — El listado "Logs recientes" (una fila por petición atendida, con
        su badge de resultado) lo construye \`renderCommanderRequestLogs\` desde
        #3949/#3951, pero su ÚNICO caller estaba dentro de \`doraMinHTML\`, que el
        rediseño kiosk V3 (#2801/#2804) dejó de emitir: la variable se arma y no
        se usa en ningún lado. Verificado sobre el dashboard vivo — \`curl :3200\`
        y \`:3299/\`, \`/v3\`, \`/multi-provider\` ⇒ cero ocurrencias de "Logs
        recientes" y cero de \`cmd-result\`.

        Consecuencia: el badge de resultado NO se renderiza en ninguna parte, y
        el estado \`huerfano\` nacería mudo — exactamente el escape #4531 que
        CA-13 viene a cerrar.

        La reparación es de RENDER PATH, no de layout: el listado se cuelga de la
        sección de Commander que la página YA emite, sin card nueva, sin mover
        nada y sin resucitar la card de DORA (que sigue muerta, fuera del alcance
        de este issue). La anatomía de la fila es la del mockup acordado
        \`assets/mockups/6440/02-dashboard-badge-huerfano.svg\`. */''}
  <details class="collapse-section"><summary>💬 Actividad Commander</summary><div class="collapse-body" style="max-height:300px;overflow-y:auto">\${renderCommanderRequestLogs(LOG_DIR)}\${actHTML}</div></details>`],
]);
