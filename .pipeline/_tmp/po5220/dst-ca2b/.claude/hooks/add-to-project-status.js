#!/usr/bin/env node
// Helper script para agregar un issue al Project V2 con status
// Uso: node add-to-project-status.js <ISSUE_NUMBER> "<STATUS_NAME>"
// Ejemplo: node add-to-project-status.js 1282 "Backlog Tecnico"

const utils = require("./project-utils.js");

async function main() {
  const issueNumber = parseInt(process.argv[2], 10);
  const statusName = process.argv[3] || "Backlog Tecnico";

  if (!issueNumber || issueNumber < 1) {
    console.error("Error: Uso: node add-to-project-status.js <ISSUE_NUMBER> [<STATUS_NAME>]");
    process.exit(1);
  }

  if (!utils.STATUS_OPTIONS[statusName]) {
    console.error(`Error: Status desconocido: "${statusName}". Opciones: ${Object.keys(utils.STATUS_OPTIONS).join(", ")}`);
    process.exit(1);
  }

  try {
    const token = utils.getGitHubToken();
    const statusOptionId = utils.STATUS_OPTIONS[statusName];

    const itemId = await utils.addAndSetStatus(token, issueNumber, statusOptionId);

    console.log(JSON.stringify({
      status: "ok",
      issueNumber: issueNumber,
      statusName: statusName,
      itemId: itemId
    }));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
