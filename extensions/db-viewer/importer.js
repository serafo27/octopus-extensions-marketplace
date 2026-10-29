// "Import from other apps": the helper scans MySQL Workbench and the JetBrains IDEs (/import/scan), the user picks
// in a preview what to import, and only then are the connections created. Never a password: an imported
// connection is marked `needsPassword` until it's edited or connects.
import { call, restartHelper } from "./api.js";
import { DEFAULTS, ENVS, PROD_COLOR } from "./connform.js";
import { esc, modal } from "./ui.js";

const hostKey = (h) => (["localhost", "127.0.0.1", "::1"].includes((h || "").toLowerCase()) ? "127.0.0.1" : (h || "").toLowerCase());
const serverKey = (c) => `${hostKey(c.host)}:${Number(c.port) || 3306}:${(c.user || "").toLowerCase()}`;

const word = (re) => new RegExp(`(^|[^a-z])(${re})([^a-z]|$)`);
const PROD = word("prod|prd|production|live");
const STAGING = word("stg|stage|staging|preprod|pre-prod|qa|uat|test|testing");
const DEV = word("dev|develop|development|local|localhost|docker");

/** The environment a name or host suggests; `guessed: false` when nothing does (then Staging, read-only). */
function guessEnv(c) {
  const text = `${c.name} ${c.host} ${c.database}`.toLowerCase();
  if (PROD.test(text)) return { env: "prod", guessed: true };
  if (STAGING.test(text)) return { env: "staging", guessed: true };
  if (DEV.test(text) || hostKey(c.host) === "127.0.0.1") return { env: "dev", guessed: true };
  return { env: "staging", guessed: false };
}

/** Opens the scan and preview; resolves with the new connections to add (none created before the user confirms). */
export async function importConnections(existing) {
  const have = new Set(existing.map(serverKey));
  let rows = [];
  let picked = null;

  const render = (dlg, r) => {
    rows = r.found.map((f) => ({ ...f, ...guessEnv(f), exists: have.has(serverKey(f)) }));
    const body = dlg.querySelector(".modal-body");
    const from = r.sources.map((s) => `<span title="${esc(s.path)}">${esc(s.app)}</span>${s.error ? ` <span class="error-text">(${esc(s.error)})</span>` : ""}`).join(", ");
    const skipped = r.skipped.length
      ? `<details class="import-skipped"><summary class="muted">${r.skipped.length} not importable</summary><ul>${r.skipped
          .map((s) => `<li><b>${esc(s.name)}</b> <span class="faint">· ${esc(s.source)}</span> — ${esc(s.reason)}</li>`)
          .join("")}</ul></details>`
      : "";
    if (!rows.length) {
      body.innerHTML = `<p class="muted">No MySQL connections found${from ? ` in ${from}` : " in MySQL Workbench or a JetBrains IDE"}.</p>${skipped}`;
      return;
    }
    const nExist = rows.filter((x) => x.exists).length;
    body.innerHTML = `
      <p class="muted import-note">${rows.length} found in ${from}.${nExist ? ` ${nExist} already in Db Viewer (same server and user): unchecked.` : ""}
        Passwords aren't imported: add each one with Edit… (or at the first connection). Imported connections are read-only; check the environments.</p>
      <table class="import-list">
        <thead><tr>
          <th><input type="checkbox" class="all" title="Select all"></th><th>Name</th><th>Server</th><th>User</th><th>From</th><th>Environment</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (x, i) => `<tr data-i="${i}" class="${x.exists ? "exists" : ""}">
              <td><input type="checkbox" class="pick" ${x.exists ? "" : "checked"}></td>
              <td>${esc(x.name || `${x.user}@${x.host}`)}${x.exists ? ' <span class="badge">already here</span>' : ""}</td>
              <td class="mono">${esc(x.host)}:${x.port}${x.database ? `/${esc(x.database)}` : ""}</td>
              <td class="mono">${esc(x.user) || '<span class="faint">—</span>'}</td>
              <td class="faint">${x.sources.map(esc).join("<br>")}</td>
              <td><select class="env" title="${x.guessed ? "Guessed from the name and host" : "Nothing in the name or host says: check it"}">${Object.entries(ENVS)
                .map(([v, l]) => `<option value="${v}" ${x.env === v ? "selected" : ""}>${l}</option>`)
                .join("")}</select>${x.guessed ? "" : ' <span class="warn-text" title="Nothing in the name or host says which environment it is">?</span>'}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>${skipped}`;
    const all = body.querySelector(".all");
    const picks = [...body.querySelectorAll(".pick")];
    const sync = () => {
      const n = picks.filter((p) => p.checked).length;
      all.checked = n === picks.length;
      all.indeterminate = n > 0 && n < picks.length;
      const btn = dlg.querySelector(".modal-foot button.primary");
      btn.disabled = !n;
      btn.textContent = n ? `Import ${n}` : "Import";
    };
    all.addEventListener("change", () => (picks.forEach((p) => (p.checked = all.checked)), sync()));
    picks.forEach((p) => p.addEventListener("change", sync));
    sync();
  };

  await modal({
    title: "Import connections from other apps",
    wide: true,
    body: '<p class="muted"><span class="spinner"></span> Looking in MySQL Workbench and the JetBrains IDEs…</p>',
    onOpen: async (dlg) => {
      dlg.classList.add("import");
      dlg.querySelector(".modal-foot button.primary").disabled = true;
      try {
        const scan = () => call("/import/scan", {}, { timeoutMs: 30000 });
        // A helper started before this version has no /import/scan: restart it once.
        render(dlg, await scan().catch((e) => (e.status === 404 ? restartHelper().then(scan) : Promise.reject(e))));
      } catch (e) {
        dlg.querySelector(".modal-body").innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
      }
    },
    buttons: [
      { label: "Cancel", value: null, cls: "ghost" },
      {
        label: "Import",
        value: "import",
        cls: "primary",
        submit: true,
        check: (dlg) => {
          picked = [...dlg.querySelectorAll(".import-list tbody tr")]
            .filter((tr) => tr.querySelector(".pick").checked)
            .map((tr) => ({ ...rows[+tr.dataset.i], env: tr.querySelector(".env").value }));
          return picked.length > 0;
        },
      },
    ],
  });
  if (!picked?.length) return [];

  const names = new Set(existing.map((c) => c.name));
  return picked.map((x) => {
    let name = x.name || `${x.user}@${x.host}`;
    for (let n = 2; names.has(name); n++) name = `${x.name || `${x.user}@${x.host}`} (${n})`;
    names.add(name);
    return {
      ...DEFAULTS,
      id: crypto.randomUUID(),
      name,
      host: x.host,
      port: x.port,
      user: x.user,
      database: x.database,
      tls: x.tls,
      tlsCa: x.tlsCa,
      env: x.env,
      readOnly: true,
      checkPlan: x.env !== "dev",
      color: x.env === "prod" ? PROD_COLOR : "",
      needsPassword: true,
      importedFrom: x.sources[0],
    };
  });
}
