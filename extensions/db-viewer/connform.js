// The connection form: where to connect, as whom, and the guard rails (environment, read-only, row limit, timeout,
// plan check).
// The password goes straight to the Keychain through the helper; the page never keeps it.
import { call, wire } from "./api.js";
import { esc, modal } from "./ui.js";

export const DEFAULTS = { driver: "mysql", host: "127.0.0.1", port: 3306, user: "", database: "", tls: "preferred", tlsCa: "", readOnly: false, rowLimit: 200, timeoutMs: 30000, color: "", env: "dev", checkPlan: false, scanWarnRows: 1000 };
export const ENVS = { dev: "Development", staging: "Staging", prod: "Production" };
const PROD_MAX_ROWS = 1000; // server.py PROD_MAX_ROWS
const COLORS = ["", "#3fb950", "#d29922", "#9e1c2c", "#f85149", "#58a6ff", "#bc8cff"];
export const PROD_COLOR = "#9e1c2c"; // bordeaux: darker than the error red

function read(dlg, base) {
  const f = (n) => dlg.querySelector(`[name=${n}]`);
  return {
    ...base,
    name: f("name").value.trim(),
    driver: "mysql",
    host: f("host").value.trim(),
    port: Number(f("port").value) || 3306,
    user: f("user").value.trim(),
    database: f("database").value.trim(),
    tls: f("tls").value,
    tlsCa: f("tlsCa").value.trim(),
    env: f("env").value,
    readOnly: f("env").value === "prod" || f("readOnly").checked,
    checkPlan: f("checkPlan").checked,
    scanWarnRows: Math.max(1000, Number(f("scanWarnRows").value) || 1000),
    rowLimit: Math.max(1, Math.min(f("env").value === "prod" ? PROD_MAX_ROWS : 50000, Number(f("rowLimit").value) || 200)),
    timeoutMs: Math.max(1, Math.min(3600, Number(f("timeout").value) || 30)) * 1000,
    color: dlg.querySelector("[name=color]:checked")?.value || "",
  };
}

/** Opens the form for a new (conn = null) or existing connection. Resolves with the saved connection or null. */
export async function editConnection(conn, { hasPassword = false, preset = {} } = {}) {
  const c = { ...DEFAULTS, ...preset, ...(conn || {}) };
  if (!conn && preset.env === "prod") Object.assign(c, { readOnly: true, checkPlan: true, color: c.color || PROD_COLOR });
  if (!conn && preset.env === "staging") c.checkPlan = true;
  const isNew = !conn;
  const body = `
    <div class="form">
      <label><span>Name</span><input name="name" value="${esc(c.name || "")}" placeholder="e.g. orders-db (prod)" autofocus></label>
      <div class="row">
        <label class="grow"><span>Host</span><input name="host" value="${esc(c.host)}" required></label>
        <label style="width:90px"><span>Port</span><input name="port" type="number" value="${esc(c.port)}"></label>
      </div>
      <div class="row">
        <label class="grow"><span>User</span><input name="user" value="${esc(c.user)}" required autocomplete="off"></label>
        <label class="grow"><span>Password</span><input name="password" type="password" autocomplete="new-password"
          placeholder="${hasPassword ? "•••••• in Keychain (leave empty to keep)" : "Stored in the macOS Keychain"}"></label>
      </div>
      ${hasPassword ? '<label class="check"><input type="checkbox" name="forget"><span>Remove the stored password</span></label>' : ""}
      <label><span>Default database <span class="faint">(optional)</span></span><input name="database" value="${esc(c.database)}"></label>
      <div class="row">
        <label class="grow"><span>TLS</span>
          <select name="tls">
            ${[["preferred", "Preferred (if the server offers it)"], ["required", "Required, any certificate"], ["verify", "Required, verify certificate and host"], ["disabled", "Disabled"]]
              .map(([v, l]) => `<option value="${v}" ${c.tls === v ? "selected" : ""}>${l}</option>`)
              .join("")}
          </select></label>
        <label class="grow"><span>CA file <span class="faint">(optional)</span></span><input name="tlsCa" value="${esc(c.tlsCa)}" placeholder="/path/to/ca.pem"></label>
      </div>
      <div class="section-title">Guard rails</div>
      <div class="row">
        <label class="grow"><span>Environment</span>
          <select name="env">${Object.entries(ENVS).map(([v, l]) => `<option value="${v}" ${c.env === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <span class="grow env-note faint"></span>
      </div>
      <label class="check"><input type="checkbox" name="readOnly" ${c.readOnly ? "checked" : ""}><span>Read-only
        <span class="faint">— the session is READ ONLY on the server; only SELECT, SHOW, DESCRIBE, EXPLAIN run</span></span></label>
      <div class="row check-plan">
        <label class="check"><input type="checkbox" name="checkPlan" ${c.checkPlan ? "checked" : ""}><span>Check the plan first
          <span class="faint">— warn before a SELECT that scans more than</span></span></label>
        <input name="scanWarnRows" type="number" min="1000" step="1000" value="${c.scanWarnRows}" style="width:100px"><span class="faint">rows</span>
      </div>
      <div class="row">
        <label class="grow"><span>Row limit <span class="faint">(LIMIT added to queries without one)</span></span><input name="rowLimit" type="number" min="1" max="50000" value="${c.rowLimit}"></label>
        <label class="grow"><span>Timeout, seconds <span class="faint">(then the query is killed)</span></span><input name="timeout" type="number" min="1" max="3600" value="${c.timeoutMs / 1000}"></label>
      </div>
      <div class="row colors">Colour
        ${COLORS.map((col) => `<label class="swatch" title="${col || "None"}"><input type="radio" name="color" value="${col}" ${c.color === col ? "checked" : ""}><span style="${col ? `background:${col}` : ""}" class="${col ? "" : "none"}"></span></label>`).join("")}
        <span class="faint">e.g. dark red for production</span>
      </div>
      <div class="test-result muted"></div>
    </div>`;

  let saved = null;
  await modal({
    onOpen: (dlg) => {
      const env = dlg.querySelector("[name=env]");
      const ro = dlg.querySelector("[name=readOnly]");
      const limit = dlg.querySelector("[name=rowLimit]");
      let wasReadOnly = ro.checked;
      const apply = (changed) => {
        const prod = env.value === "prod";
        if (prod && !ro.disabled) wasReadOnly = ro.checked;
        ro.disabled = prod;
        ro.checked = prod || wasReadOnly;
        limit.max = prod ? PROD_MAX_ROWS : 50000;
        if (prod && Number(limit.value) > PROD_MAX_ROWS) limit.value = PROD_MAX_ROWS;
        dlg.querySelector(".env-note").textContent = prod ? `Always read-only, at most ${PROD_MAX_ROWS} rows per query.` : "";
        if (changed && env.value !== "dev") dlg.querySelector("[name=checkPlan]").checked = true;
        // Development writes (each write still asks, with a dry run); staging starts read-only.
        if (changed && !prod) ro.checked = wasReadOnly = env.value !== "dev";
        if (changed && prod && !dlg.querySelector("[name=color]:checked")?.value) dlg.querySelector(`[name=color][value="${PROD_COLOR}"]`).checked = true;
      };
      env.addEventListener("change", () => apply(true));
      apply(false);
    },
    title: isNew ? "New MySQL connection" : `Edit ${c.name || c.host}`,
    body,
    wide: true,
    buttons: [
      {
        label: "Test",
        cls: "ghost",
        action: async (dlg) => {
          const out = dlg.querySelector(".test-result");
          const draft = read(dlg, { ...c, id: c.id || "draft" });
          const pw = dlg.querySelector("[name=password]").value;
          out.className = "test-result muted";
          out.innerHTML = '<span class="spinner"></span> Connecting…';
          try {
            const body = { conn: wire(draft) };
            // An unsaved password, or no stored one yet: test with what's typed (it isn't stored by a test).
            if (pw || !hasPassword || dlg.querySelector("[name=forget]")?.checked) body.password = pw;
            const r = await call("/test", body, { timeoutMs: 30000 });
            out.className = "test-result success";
            out.textContent = `Connected in ${r.ms} ms · MySQL ${r.version} as ${r.user} · ${r.tls ? "TLS " + r.tls : "no TLS"}`;
          } catch (e) {
            out.className = "test-result error";
            out.textContent = e.message;
          }
        },
      },
      { label: "Cancel", value: null, cls: "ghost" },
      {
        label: "Save",
        value: "save",
        cls: "primary",
        submit: true,
        check: (dlg) => {
          const draft = read(dlg, c);
          if (!draft.host || !draft.user) {
            dlg.querySelector(".test-result").className = "test-result error";
            dlg.querySelector(".test-result").textContent = "Host and user are needed.";
            return false;
          }
          draft.id = c.id || crypto.randomUUID();
          draft.name = draft.name || `${draft.user}@${draft.host}`;
          const pw = dlg.querySelector("[name=password]").value;
          const forget = dlg.querySelector("[name=forget]")?.checked;
          saved = { conn: draft, password: pw, forget };
          return true;
        },
      },
    ],
  });
  if (!saved) return null;
  if (saved.password || saved.forget) await call("/secret/set", { id: saved.conn.id, password: saved.forget && !saved.password ? "" : saved.password });
  return saved.conn;
}
