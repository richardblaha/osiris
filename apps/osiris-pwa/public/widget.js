/*
 * Osiris chat widget for a business's website:
 *   <script src="https://osiris.k6labs.cz/widget.js" data-project="<project>" data-assistant="<assistant>" async></script>
 * A button in the corner opens the business's public assistant (osiris.k6labs.cz/c/<project>/<assistant>) in a panel;
 * without data-assistant, the project's first one. The button speaks the page's language (data-lang, else <html lang>,
 * else the browser's): English, or Czech for Czech and Slovak; data-label replaces its text.
 */
(function () {
  var script = document.currentScript;
  var project = script && script.getAttribute("data-project");
  var assistant = script && script.getAttribute("data-assistant");
  if (!project || document.getElementById("osiris-widget")) return;
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#0f766e";
  var texts = { en: { label: "Ask us", close: "Close" }, cs: { label: "Zeptejte se nás", close: "Zavřít" } };
  var lang = (script.getAttribute("data-lang") || document.documentElement.lang || navigator.language || "en").toLowerCase().split("-")[0];
  var text = texts[lang === "sk" ? "cs" : lang] || texts.en;
  var label = script.getAttribute("data-label") || text.label;

  var root = document.createElement("div");
  root.id = "osiris-widget";
  root.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;font:14px system-ui,sans-serif";

  var frame = document.createElement("iframe");
  frame.title = label;
  frame.style.cssText =
    "display:none;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 96px));border:0;border-radius:12px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.25);margin-bottom:12px;background:#fff";

  var button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-expanded", "false");
  button.style.cssText =
    "display:block;margin-inline-start:auto;padding:12px 18px;border:0;border-radius:999px;color:#fff;cursor:pointer;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.2);background:" + color;
  button.addEventListener("click", function () {
    var open = frame.style.display === "none";
    // The chat loads the first time it's opened.
    if (open && !frame.src) frame.src = origin + "/c/" + encodeURIComponent(project) + (assistant ? "/" + encodeURIComponent(assistant) : "") + "?embed=1";
    frame.style.display = open ? "block" : "none";
    button.textContent = open ? text.close : label;
    button.setAttribute("aria-expanded", String(open));
  });

  root.appendChild(frame);
  root.appendChild(button);
  document.body.appendChild(root);
})();
