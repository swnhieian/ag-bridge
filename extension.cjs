const vscode = require("vscode");

async function load() {
  return import("./dist/src/extension.js");
}

async function activate(context) {
  const mod = await load();
  return mod.activateExtension(vscode, context);
}

async function deactivate() {
  const mod = await load();
  if (typeof mod.deactivateExtension === "function") {
    return mod.deactivateExtension();
  }
}

module.exports = {
  activate,
  deactivate,
};
