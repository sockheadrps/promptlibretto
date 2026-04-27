// Per-browser workspace identity + optional studio token.
//
// The server multiplexes its data by workspace id. Each browser mints a
// UUID on first load and re-sends it on every /api/* call. Clearing site
// storage loses the binding — we warn the user before they act on it.
//
// If the server runs behind STUDIO_TOKEN, it will 401 calls without the
// matching bearer. We prompt for the token once, stash in localStorage,
// and attach it to subsequent requests.

const WS_KEY = "promptlibretto.workspace";
const TOKEN_KEY = "promptlibretto.studio_token";

function ensureWorkspaceId() {
  let id = localStorage.getItem(WS_KEY);
  if (!id || !isUuid(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(WS_KEY, id);
  }
  return id;
}

function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function getWorkspaceId() {
  return ensureWorkspaceId();
}

export function setWorkspaceId(id) {
  if (!isUuid(id)) throw new Error("workspace id must be a UUID");
  localStorage.setItem(WS_KEY, id);
  return id;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(tok) {
  if (tok) localStorage.setItem(TOKEN_KEY, tok);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Build request headers with workspace + optional token. */
export function authHeaders(extra = {}) {
  const headers = { "X-Workspace": ensureWorkspaceId(), ...extra };
  const tok = getToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  return headers;
}

/** Install a global fetch wrapper so every /api/* call gets the headers
 *  automatically. Modules that import this file get patched behavior. */
const _origFetch = window.fetch.bind(window);
window.fetch = async function promptlibrettoFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const isApi = typeof url === "string" && url.startsWith("/api/");
  if (!isApi) return _origFetch(input, init);
  const nextInit = { ...init, headers: authHeaders(init.headers || {}) };
  const res = await _origFetch(input, nextInit);
  if (res.status === 401) {
    // One retry after prompting for a token — don't loop.
    const prompted = promptForToken();
    if (prompted) {
      nextInit.headers = authHeaders(init.headers || {});
      return _origFetch(input, nextInit);
    }
  }
  return res;
};

function promptForToken() {
  const tok = window.prompt(
    "This studio is token-protected. Paste the STUDIO_TOKEN:",
    getToken()
  );
  if (tok === null) return false;
  const trimmed = tok.trim();
  if (!trimmed) return false;
  setToken(trimmed);
  return true;
}

// ── Workspace chip ───────────────────────────────────────────────

export function mountWorkspaceChip(container) {
  if (!container) return;
  const id = ensureWorkspaceId();
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "meta-chip meta-chip--action ws-chip";
  chip.innerHTML = `
    <span class="chip-label">ws</span>
    <span class="chip-sep">·</span>
    <span class="chip-model">${id.slice(0, 8)}</span>
  `;
  chip.title = "Click for workspace options (copy / restore)";
  chip.addEventListener("click", openWorkspaceDialog);
  container.appendChild(chip);
}

function openWorkspaceDialog() {
  const id = ensureWorkspaceId();
  let modal = document.getElementById("workspace-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "workspace-modal";
    modal.className = "modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-backdrop" data-close-ws></div>
      <div class="modal-card">
        <header>
          <h3>Workspace</h3>
          <button class="modal-close" type="button" data-close-ws>×</button>
        </header>
        <div class="modal-body">
          <p class="hint">Your data (saved bases, snapshots, exports, custom routes) is scoped to this workspace ID. Copy it if you want to resume on another device. <strong>Clearing site storage deletes your binding to this workspace — keep the ID somewhere safe.</strong></p>
          <div class="dialog-form">
            <label>Current ID
              <input type="text" id="ws-current" readonly />
            </label>
            <div class="dialog-actions">
              <button type="button" class="ghost" id="ws-copy">Copy</button>
              <span class="spacer" style="flex:1"></span>
            </div>
            <label>Restore from another device
              <input type="text" id="ws-restore" placeholder="paste a workspace UUID" />
            </label>
            <div class="dialog-actions">
              <button type="button" class="ghost" data-close-ws>Cancel</button>
              <button type="button" class="primary" id="ws-apply">Switch workspace</button>
            </div>
            <div id="ws-status" class="hint"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-ws]")) modal.hidden = true;
    });
    modal.querySelector("#ws-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(modal.querySelector("#ws-current").value);
      const s = modal.querySelector("#ws-status");
      s.textContent = "Copied.";
      s.dataset.kind = "ok";
    });
    modal.querySelector("#ws-apply").addEventListener("click", () => {
      const v = modal.querySelector("#ws-restore").value.trim();
      if (!isUuid(v)) {
        const s = modal.querySelector("#ws-status");
        s.textContent = "That doesn't look like a UUID.";
        s.dataset.kind = "err";
        return;
      }
      setWorkspaceId(v);
      window.location.reload();
    });
  }
  modal.querySelector("#ws-current").value = ensureWorkspaceId();
  modal.querySelector("#ws-restore").value = "";
  modal.querySelector("#ws-status").textContent = "";
  modal.hidden = false;
}
