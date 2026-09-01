"use strict";
(() => {
  // webview/main.ts
  var vscodeApi = acquireVsCodeApi();
  var stage = document.getElementById("stage");
  var issuesEl = document.getElementById("issues");
  var summaryEl = document.getElementById("summary");
  function selectId(id) {
    if (!id) {
      return;
    }
    for (const el of stage.querySelectorAll("[data-id]")) {
      el.classList.toggle("selected", el.getAttribute("data-id") === id);
    }
    vscodeApi.postMessage({ type: "select", id });
  }
  function renderIssues(issues) {
    issuesEl.innerHTML = "";
    for (const issue of issues) {
      const row = document.createElement("div");
      row.className = `issue ${issue.severity}`;
      row.textContent = `${issue.code}: ${issue.message}`;
      row.title = issue.path;
      if (issue.nodeId) {
        row.addEventListener("click", () => selectId(issue.nodeId));
      }
      issuesEl.appendChild(row);
    }
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "error") {
      stage.textContent = `Parse error: ${msg.message}`;
      summaryEl.textContent = "invalid document";
      issuesEl.innerHTML = "";
      return;
    }
    stage.innerHTML = msg.svg;
    summaryEl.textContent = `${msg.stats.equipment} equipment \xB7 ${msg.stats.segments} segments \xB7 ${msg.summary.errors} errors \xB7 ${msg.summary.warnings} warnings`;
    for (const el of stage.querySelectorAll("[data-id]")) {
      el.addEventListener("click", () => selectId(el.getAttribute("data-id") ?? ""));
    }
    renderIssues(msg.issues);
  });
  vscodeApi.postMessage({ type: "ready" });
})();
//# sourceMappingURL=preview.js.map
