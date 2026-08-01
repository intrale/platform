#!/usr/bin/env node
// Script de reparación masiva: asignar status a items sin estado en Project V2
// Uso: node fix-project-status.js [--dry-run] [--max-items N]
// Requiere token gh con scope 'project'

const { execSync } = require("child_process");
const https = require("https");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "/c/Workspaces/Intrale/platform";
const LOG_FILE = path.join(PROJECT_DIR, ".claude", "hooks", "fix-project-status.log");

const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";

const STATUS_OPTIONS = {
  "Backlog Tecnico": "4fef8264",
  "Backlog CLIENTE": "74b58f5f",
  "Backlog NEGOCIO": "1e51e9ff",
  "Backlog DELIVERY": "0fa31c9f",
  "Done": "b30e67ed"
};

const DRY_RUN = process.argv.indexOf("--dry-run") !== -1;
const MAX_ITEMS_ARG = process.argv.find((arg) => arg.startsWith("--max-items="));
const MAX_ITEMS = MAX_ITEMS_ARG ? parseInt(MAX_ITEMS_ARG.split("=")[1], 10) : 999;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

function getGitHubToken() {
  try {
    const token = execSync("gh auth token", {
      encoding: "utf8",
      cwd: PROJECT_DIR,
      timeout: 5000,
      windowsHide: true
    }).trim();
    if (token) return token;
  } catch (e) {}

  const credInput = "protocol=https\nhost=github.com\n\n";
  const result = execSync("git credential fill", {
    input: credInput,
    encoding: "utf8",
    cwd: PROJECT_DIR,
    timeout: 5000,
    windowsHide: true
  });
  const match = result.match(/password=(.+)/);
  if (!match) throw new Error("No se encontro password en git credential fill");
  return match[1].trim();
}

function graphqlRequest(token, query, variables) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query: query, variables: variables || {} });
    const req = https.request({
      hostname: "api.github.com",
      path: "/graphql",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        "Authorization": "bearer " + token,
        "User-Agent": "intrale-fix-status"
      },
      timeout: 8000
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors && parsed.errors.length > 0) {
            reject(new Error(parsed.errors[0].message));
          } else {
            resolve(parsed.data);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout graphql")); });
    req.on("error", (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

async function listItemsWithoutStatus(token, limit) {
  // Query para obtener todos los items sin status asignado
  const query = `query($projectId:ID!,$limit:Int!) {
    node(id:$projectId) {
      ... on ProjectV2 {
        items(first:$limit) {
          nodes {
            id
            content {
              ... on Issue {
                number
                title
                state
                labels(first:20) {
                  nodes { name }
                }
              }
            }
            fieldValueByName(name:"Status") {
              __typename
            }
          }
        }
      }
    }
  }`;

  const data = await graphqlRequest(token, query, {
    projectId: PROJECT_ID,
    limit: Math.min(limit, 100)
  });

  const items = data && data.node && data.node.items && data.node.items.nodes;
  if (!items) {
    throw new Error("No se pudieron obtener items del proyecto");
  }

  // Filtrar items sin status (fieldValueByName es null)
  return items.filter(function(item) {
    return item.content &&
           item.content.number &&
           (!item.fieldValueByName || item.fieldValueByName.__typename === null);
  });
}

function determineStatus(labels, state) {
  // Issues cerrados -> Done
  if (state === "CLOSED") {
    return { name: "Done", optionId: STATUS_OPTIONS["Done"] };
  }

  // Determinar backlog según labels
  let labelNames = [];
  if (labels && Array.isArray(labels)) {
    labelNames = labels.map(function(l) { return l.name; });
  } else if (labels && labels.nodes && Array.isArray(labels.nodes)) {
    labelNames = labels.nodes.map(function(l) { return l.name; });
  }

  if (labelNames.indexOf("app:client") !== -1) {
    return { name: "Backlog CLIENTE", optionId: STATUS_OPTIONS["Backlog CLIENTE"] };
  }
  if (labelNames.indexOf("app:business") !== -1) {
    return { name: "Backlog NEGOCIO", optionId: STATUS_OPTIONS["Backlog NEGOCIO"] };
  }
  if (labelNames.indexOf("app:delivery") !== -1) {
    return { name: "Backlog DELIVERY", optionId: STATUS_OPTIONS["Backlog DELIVERY"] };
  }

  // Default: Backlog Tecnico
  return { name: "Backlog Tecnico", optionId: STATUS_OPTIONS["Backlog Tecnico"] };
}

async function setItemStatus(token, itemId, optionId) {
  const mutation = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!) {
    updateProjectV2ItemFieldValue(input:{
      projectId:$projectId
      itemId:$itemId
      fieldId:$fieldId
      value:{singleSelectOptionId:$optionId}
    }) {
      projectV2Item { id }
    }
  }`;

  await graphqlRequest(token, mutation, {
    projectId: PROJECT_ID,
    itemId: itemId,
    fieldId: FIELD_ID,
    optionId: optionId
  });
}

async function main() {
  try {
    log("=== fix-project-status.js iniciado ===");
    if (DRY_RUN) log("MODO DRY-RUN (sin cambios reales)");

    const token = getGitHubToken();
    log("Token obtenido exitosamente");

    const items = await listItemsWithoutStatus(token, MAX_ITEMS);
    log(`${items.length} items sin status encontrados`);

    if (items.length === 0) {
      log("Nada que reparar. Saliendo.");
      process.exit(0);
    }

    let fixed = 0;
    let errors = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const issue = item.content;
      const issueNum = issue.number;

      try {
        const statusInfo = determineStatus(issue.labels, issue.state);
        const action = DRY_RUN ? "DRY-RUN" : "FIXING";

        log(`[${action}] #${issueNum} "${issue.title}" → ${statusInfo.name}`);

        if (!DRY_RUN) {
          await setItemStatus(token, item.id, statusInfo.optionId);
          fixed++;
        } else {
          fixed++;  // Contar como "corregido" en dry-run
        }

        // Rate limiting: máximo ~30 mutaciones/minuto
        // Esperar 2 segundos entre mutaciones para ser conservador
        if (i < items.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error) {
        log(`ERROR #${issueNum}: ${error.message}`);
        errors++;
      }
    }

    log(`=== RESULTADO ===`);
    log(`Reparadas: ${fixed}/${items.length}`);
    log(`Errores: ${errors}`);
    log(`Tasa de éxito: ${((fixed / items.length) * 100).toFixed(1)}%`);

    if (DRY_RUN) {
      log("(No se realizaron cambios — modo DRY-RUN)");
    }

    process.exit(errors > 0 ? 1 : 0);
  } catch (error) {
    log(`FATAL: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
