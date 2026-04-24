(function() {
  if (window.__mesh_active) return;
  window.__mesh_active = true;

  const style = document.createElement("style");
  style.textContent = `
    .mesh-highlight { outline: 3px solid #00ffcc !important; box-shadow: 0 0 15px #00ffcc !important; }
    #mesh-prompt-panel {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      width: 500px; background: #111; color: white; border: 1px solid #00ffcc;
      border-radius: 12px; z-index: 1000000; font-family: system-ui; padding: 15px;
      box-shadow: 0 30px 60px rgba(0,0,0,0.8); display: none;
    }
    #mesh-prompt-input {
      width: 100%; background: #000; border: none; color: white; 
      font-size: 16px; padding: 10px; outline: none; margin-bottom: 10px;
    }
    .mesh-hint { font-size: 10px; color: #555; text-align: center; }
    .mesh-badge { background: #00ffcc; color: #000; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-right: 8px; }
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "mesh-prompt-panel";
  panel.innerHTML = `
    <div style="display: flex; align-items: center; margin-bottom: 10px;">
      <span class="mesh-badge">MESH AI</span>
      <span id="mesh-target-label" style="font-size: 12px; color: #888;"></span>
    </div>
    <input type="text" id="mesh-prompt-input" placeholder="Describe change (e.g. 'Make this a modern card', 'Center items')...">
    <div class="mesh-hint">Press Enter to sync change to code</div>
  `;
  document.body.appendChild(panel);

  let selectedElement = null;

  // Global function for CLI to push styles back
  window.__mesh_apply_ghost = function(styles) {
    if (!selectedElement) return;
    console.log("[Mesh] Applying Ghost Styles:", styles);
    Object.assign(selectedElement.style, styles);
  };

  document.addEventListener("click", (e) => {
    if (!e.altKey) return;
    e.preventDefault(); e.stopPropagation();

    if (selectedElement) selectedElement.classList.remove("mesh-highlight");
    selectedElement = e.target;
    selectedElement.classList.add("mesh-highlight");

    document.getElementById("mesh-target-label").innerText = `<${selectedElement.tagName.toLowerCase()}> in ${selectedElement.className.split(' ').slice(0,2).join('.') || 'element'}`;
    panel.style.display = "block";
    document.getElementById("mesh-prompt-input").focus();
  }, true);

  document.getElementById("mesh-prompt-input").addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && selectedElement) {
      const prompt = e.target.value;
      if (!prompt) return;

      e.target.disabled = true;
      e.target.placeholder = "Agent is designing...";

      const fiberKey = Object.keys(selectedElement).find(k => k.startsWith("__reactFiber$"));
      const fiber = selectedElement[fiberKey];
      let source = fiber?._debugSource || fiber?.return?._debugSource;

      const payload = {
        type: "PROMPT",
        file: source ? source.fileName : "unknown",
        line: source ? source.lineNumber : 0,
        prompt: prompt,
        context: {
          tag: selectedElement.tagName,
          html: selectedElement.outerHTML.substring(0, 1000),
          parentHtml: selectedElement.parentElement ? selectedElement.parentElement.outerHTML.substring(0, 2000) : "",
          classes: selectedElement.className
        }
      };

      if (window.meshEmit) window.meshEmit(JSON.stringify(payload));

      // Visual feedback loop
      setTimeout(() => {
        panel.style.display = "none";
        e.target.disabled = false;
        e.target.value = "";
        e.target.placeholder = "Describe change...";
        if (selectedElement) selectedElement.classList.remove("mesh-highlight");
      }, 1000);
    }
  });
})();
