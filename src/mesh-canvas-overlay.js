(function() {
  if (window.__mesh_active) return;
  window.__mesh_active = true;
  const requestLog = [];
  let lastSelectionAt = 0;

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
    <span class="mesh-badge">MESH X-RAY</span>
    <span id="mesh-target-label" style="font-size: 12px; color: #888;"></span>
  </div>
  <div id="mesh-xray-details" style="font-size: 11px; color: #aaa; margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 8px; display: none;">
    <div style="color: #00ffcc; margin-bottom: 4px;">Detected Data Flow:</div>
    <div id="mesh-flow-path"></div>
  </div>
  <input type="text" id="mesh-prompt-input" placeholder="Describe change (e.g. 'Make this a modern card')...">
  <div class="mesh-hint">Press Enter to sync change to code</div>
  `;
  document.body.appendChild(panel);

  let selectedElement = null;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = async function(input, init) {
      const startedAt = performance.now();
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input === "object" && input && input.method) || "GET").toUpperCase();
      try {
        const response = await originalFetch(input, init);
        recordRequest({
          type: "fetch",
          method,
          url: resolveUrl(url),
          route: routeFor(url),
          status: response.status,
          ok: response.ok,
          durationMs: Math.round(performance.now() - startedAt),
          startedAt: Date.now()
        });
        return response;
      } catch (error) {
        recordRequest({
          type: "fetch",
          method,
          url: resolveUrl(url),
          route: routeFor(url),
          status: 0,
          ok: false,
          error: error && error.message ? error.message : String(error),
          durationMs: Math.round(performance.now() - startedAt),
          startedAt: Date.now()
        });
        throw error;
      }
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__meshRequestMeta = {
      type: "xhr",
      method: String(method || "GET").toUpperCase(),
      url: resolveUrl(url),
      route: routeFor(url),
      startedAt: 0
    };
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (this.__meshRequestMeta) {
      this.__meshRequestMeta.startedAt = Date.now();
      this.addEventListener("loadend", () => {
        recordRequest({
          type: "xhr",
          method: this.__meshRequestMeta.method,
          url: this.__meshRequestMeta.url,
          route: this.__meshRequestMeta.route,
          status: this.status,
          ok: this.status >= 200 && this.status < 400,
          durationMs: Date.now() - this.__meshRequestMeta.startedAt,
          startedAt: this.__meshRequestMeta.startedAt
        });
      }, { once: true });
    }
    return originalSend.apply(this, arguments);
  };

  function recordRequest(entry) {
    requestLog.push(entry);
    while (requestLog.length > 100) requestLog.shift();
  }

  function resolveUrl(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return String(url || "");
    }
  }

  function routeFor(url) {
    try {
      return new URL(url, window.location.href).pathname || "/";
    } catch {
      return String(url || "/");
    }
  }

  function getFiber(node) {
    if (!node) return null;
    const key = Object.keys(node).find((value) => value.startsWith("__reactFiber$"));
    return key ? node[key] : null;
  }

  function getComponentName(fiber) {
    const candidate = fiber && (fiber.type || fiber.elementType || fiber.return && fiber.return.type);
    if (!candidate) return "Anonymous";
    return candidate.displayName || candidate.name || candidate.type?.displayName || candidate.type?.name || "Anonymous";
  }

  function getSourceInfo(node) {
    const fiber = getFiber(node);
    const source = fiber && (fiber._debugSource || fiber.return && fiber.return._debugSource);
    return {
      fiber,
      source,
      component: getComponentName(fiber),
      owner: fiber && fiber.return ? getComponentName(fiber.return) : "Anonymous"
    };
  }

  function collectRecentRequests() {
    const now = Date.now();
    const cutoff = Math.max(lastSelectionAt, now - 15000);
    return requestLog
      .filter((entry) => entry.startedAt >= cutoff)
      .slice(-12)
      .map((entry) => ({
        type: entry.type,
        method: entry.method,
        route: entry.route,
        url: entry.url,
        status: entry.status,
        ok: entry.ok,
        durationMs: entry.durationMs,
        error: entry.error || null
      }));
  }

  function traceDataFlow(el) {
    const { source, component, owner } = getSourceInfo(el);
    const flow = [];
    flow.push(`UI: <${el.tagName.toLowerCase()}>`);
    flow.push(`Component: ${component}`);
    if (source && source.fileName) {
      flow.push(`Source: ${source.fileName}:${source.lineNumber || 0}`);
    }
    if (owner && owner !== "Anonymous") {
      flow.push(`Owner: ${owner}`);
    }
    const requests = collectRecentRequests();
    if (requests.length > 0) {
      for (const request of requests.slice(0, 5)) {
        flow.push(`Request: ${request.method} ${request.route} -> ${request.status}`);
      }
    } else {
      flow.push("Request: none captured for the current selection");
    }
    return flow;
  }

  function buildXrayPayload(el, prompt) {
    const { source, component, owner } = getSourceInfo(el);
    const requests = collectRecentRequests();
    return {
      type: "PROMPT",
      page: window.location.href,
      prompt,
      source: source ? {
        fileName: source.fileName,
        lineNumber: source.lineNumber,
        columnNumber: source.columnNumber || 0
      } : null,
      component,
      owner,
      requests,
      context: {
        tag: el.tagName,
        html: el.outerHTML.substring(0, 1000),
        parentHtml: el.parentElement ? el.parentElement.outerHTML.substring(0, 2000) : "",
        classes: el.className
      }
    };
  }

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
    lastSelectionAt = Date.now();

    const sourceInfo = getSourceInfo(selectedElement);
    document.getElementById("mesh-target-label").innerText = `<${selectedElement.tagName.toLowerCase()}> in ${selectedElement.className.split(' ').slice(0,2).join('.') || 'element'}${sourceInfo.component ? ` · ${sourceInfo.component}` : ""}`;

    const flow = traceDataFlow(selectedElement);
    const flowPath = document.getElementById("mesh-flow-path");
    flowPath.innerHTML = flow.map(step => `<div style="margin-left: 10px;">→ ${step}</div>`).join('');
    document.getElementById("mesh-xray-details").style.display = "block";

    panel.style.display = "block";
    document.getElementById("mesh-prompt-input").focus();
  }, true);
  document.getElementById("mesh-prompt-input").addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && selectedElement) {
      const prompt = e.target.value;
      if (!prompt) return;

      e.target.disabled = true;
      e.target.placeholder = "Agent is designing...";
      const payload = buildXrayPayload(selectedElement, prompt);

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
