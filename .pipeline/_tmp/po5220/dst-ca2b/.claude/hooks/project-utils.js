// Utilidades compartidas para operaciones de Project V2
// Reutilizable desde: /historia, /refinar, post-issue-close.js, scripts futuros

const { execSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "/c/Workspaces/Intrale/platform";

// IDs del Project V2 "Intrale"
const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";

// Option IDs para cada columna
const STATUS_OPTIONS = {
  "Backlog Tecnico": "4fef8264",
  "Backlog CLIENTE": "74b58f5f",
  "Backlog NEGOCIO": "1e51e9ff",
  "Backlog DELIVERY": "0fa31c9f",
  "Todo": "ec963918",
  "Refined": "bac097c6",
  "In Progress": "29e2553a",
  "Ready": "6bec465d",
  "QA Pending": "dcd0a053",
  "Done": "b30e67ed",
  "Blocked": "487cf163"
};

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

  // Fallback: git credential fill
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
        "User-Agent": "intrale-hook"
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

async function getProjectItemIdForIssue(token, issueNumber) {
  const query = `query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      issue(number:$number){
        projectItems(first:10){
          nodes{
            id
            project{id}
          }
        }
      }
    }
  }`;

  const data = await graphqlRequest(token, query, {
    owner: "intrale",
    repo: "platform",
    number: issueNumber
  });

  const nodes = data && data.repository && data.repository.issue &&
                data.repository.issue.projectItems &&
                data.repository.issue.projectItems.nodes;

  if (!nodes || nodes.length === 0) {
    return null;
  }

  // Filtrar por el project ID correcto
  const item = nodes.find(function(n) { return n.project && n.project.id === PROJECT_ID; });
  return item ? item.id : null;
}

async function setProjectStatus(token, itemId, statusOptionId) {
  const mutation = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
    updateProjectV2ItemFieldValue(input:{
      projectId:$projectId,
      itemId:$itemId,
      fieldId:$fieldId,
      value:{singleSelectOptionId:$optionId}
    }){
      projectV2Item{id}
    }
  }`;

  await graphqlRequest(token, mutation, {
    projectId: PROJECT_ID,
    itemId: itemId,
    fieldId: FIELD_ID,
    optionId: statusOptionId
  });
}

function getBacklogOptionId(labels) {
  // Determinar backlog según labels
  if (labels.indexOf("app:client") !== -1) {
    return STATUS_OPTIONS["Backlog CLIENTE"];
  }
  if (labels.indexOf("app:business") !== -1) {
    return STATUS_OPTIONS["Backlog NEGOCIO"];
  }
  if (labels.indexOf("app:delivery") !== -1) {
    return STATUS_OPTIONS["Backlog DELIVERY"];
  }

  // Issues cerrados -> Done
  // (caller debe pasar estado del issue)

  // Default: Backlog Tecnico (infra, backend sin app)
  return STATUS_OPTIONS["Backlog Tecnico"];
}

async function addToProject(issueUrl) {
  // Ejecutar gh project item-add
  // Retorna void, pero si no falla significa que se agregó
  try {
    execSync(`gh project item-add 1 --owner intrale --url "${issueUrl}"`, {
      cwd: PROJECT_DIR,
      timeout: 10000,
      windowsHide: true
    });
    return true;
  } catch (e) {
    throw new Error("No se pudo agregar issue al proyecto: " + e.message);
  }
}

async function addAndSetStatus(token, issueNumber, statusOptionId) {
  const issueUrl = `https://github.com/intrale/platform/issues/${issueNumber}`;

  // Agregar al proyecto
  await addToProject(issueUrl);

  // Esperar a que GitHub procese la adición (pequeño delay)
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Obtener el itemId
  const itemId = await getProjectItemIdForIssue(token, issueNumber);
  if (!itemId) {
    throw new Error(`No se pudo obtener itemId para issue #${issueNumber} después de agregarlo`);
  }

  // Establecer el status
  await setProjectStatus(token, itemId, statusOptionId);

  return itemId;
}

module.exports = {
  PROJECT_ID,
  FIELD_ID,
  STATUS_OPTIONS,
  getGitHubToken,
  graphqlRequest,
  getProjectItemIdForIssue,
  setProjectStatus,
  getBacklogOptionId,
  addToProject,
  addAndSetStatus
};
