// Where to connect: a project folder (its local agent) or an Osiris server; the last few are offered again.
const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

const english = !/^(cs|sk)/i.test(navigator.language);
const texts = {
  folder: "Project in a folder",
  folderHint: "Osiris runs on this computer over the project's folder.",
  chooseFolder: "Open folder…",
  server: "Osiris server",
  connect: "Connect",
  recent: "Recent",
  starting: "Starting Osiris…",
};
if (english) {
  document.documentElement.lang = "en";
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = texts[el.dataset.t];
}
const starting = english ? texts.starting : "Spouštím Osiris…";

const status = document.getElementById("status");
const RECENT = "osiris.recent";
const recent = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {
    return [];
  }
};
const remember = (entry) =>
  localStorage.setItem(RECENT, JSON.stringify([entry, ...recent().filter((r) => r.kind !== entry.kind || r.target !== entry.target)].slice(0, 6)));

async function go(entry) {
  status.className = "hint";
  status.textContent = entry.kind === "folder" ? starting : "";
  try {
    const url = entry.kind === "folder" ? (await invoke("open_folder", { folder: entry.target })).url : entry.target;
    remember(entry);
    await invoke("navigate", { url });
  } catch (err) {
    status.className = "hint error";
    status.textContent = String(err);
  }
}

document.getElementById("folder").addEventListener("click", async () => {
  const folder = await open({ directory: true });
  if (folder) await go({ kind: "folder", target: folder });
});
document.getElementById("server").addEventListener("submit", async (e) => {
  e.preventDefault();
  await go({ kind: "server", target: document.getElementById("url").value.replace(/\/$/, "") });
});

const list = recent();
if (list.length) {
  document.getElementById("recentSection").hidden = false;
  const ul = document.getElementById("recent");
  for (const entry of list) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    const name = entry.target.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.target;
    button.innerHTML = `${entry.kind === "folder" ? "📁" : "🌐"} <span></span><br /><small></small>`;
    button.querySelector("span").textContent = entry.kind === "folder" ? name : entry.target;
    button.querySelector("small").textContent = entry.kind === "folder" ? entry.target : "";
    button.addEventListener("click", () => go(entry));
    li.append(button);
    ul.append(li);
  }
}
