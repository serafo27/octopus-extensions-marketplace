// A connection's sessions: what Db Viewer is running on it, and the server's process list (all threads with the
// PROCESS privilege, else this user's), with Kill query / Kill connection. Refreshes every 2 s while shown.
import { call, wire } from "./api.js";
import { icons } from "./icons.js";
import { envBanner } from "./query.js";
import { confirmDialog, esc, modal } from "./ui.js";

const REFRESH_MS = 2000;

function duration(s) {
  s = Number(s) || 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export class SessionsTab {
  constructor(app, { conn }) {
    this.app = app;
    this.kind = "sessions";
    this.connId = conn.id;
    this.schema = "";
    this.data = null;
    this.el = document.createElement("div");
    this.el.className = "sessions-tab";
    this.el.innerHTML = `
      <div class="toolbar s-head">
        <span class="t-title">${icons.pulse}<b>Sessions</b><span class="faint">${esc(conn.name)}</span></span>
        <span class="grow"></span>
        <label class="check-inline"><input type="checkbox" class="hide-idle" checked> Hide idle</label>
        <label class="check-inline"><input type="checkbox" class="mine" checked> Only my user</label>
        <label class="check-inline"><input type="checkbox" class="auto" checked> Auto-refresh</label>
        <button class="ghost icon refresh" title="Refresh">${icons.refresh}</button>
        <button class="ghost disconnect" title="Close Db Viewer's idle sessions on this server and stop what it runs">${icons.disconnect}<span>Disconnect</span></button>
      </div>
      <div class="s-body">
        <div class="s-section"><div class="s-title">Running from Db Viewer</div><div class="s-ours"></div></div>
        <div class="s-section"><div class="s-title">On the server <span class="s-count faint"></span></div><div class="s-server"></div></div>
      </div>`;
    envBanner(this.el, conn);
    const $ = (s) => this.el.querySelector(s);
    $(".refresh").onclick = () => this.load();
    $(".disconnect").onclick = () => this.app.disconnect(this.conn).then(() => this.load());
    for (const c of [".hide-idle", ".mine"]) $(c).onchange = () => this.render();
    $(".auto").onchange = () => this.schedule();
    this.el.addEventListener("click", (e) => this.click(e));
    this.load();
  }

  get conn() {
    return this.app.connById(this.connId);
  }

  connectionChanged() {
    if (this.app.isConnected(this.connId)) this.load();
    else this.render();
  }

  get title() {
    return `Sessions · ${this.conn?.name || ""}`;
  }

  /** Polls while this tab is the one shown and Octopus shows the extension. */
  schedule() {
    clearTimeout(this.timer);
    if (!this.el.isConnected) return;
    this.timer = setTimeout(() => {
      const shown = !this.el.hidden && !document.hidden;
      // A disconnected connection isn't polled: that would open a session on the server every 2 s.
      if (shown && this.el.querySelector(".auto").checked && this.app.isConnected(this.connId)) this.load();
      else this.schedule();
    }, REFRESH_MS);
  }

  async load() {
    clearTimeout(this.timer);
    if (!this.app.isConnected(this.connId)) await this.app.schemasOf(this.connId);
    try {
      const [list, status] = await Promise.all([call("/processlist", { conn: wire(this.conn) }), call("/status", {})]);
      this.data = list;
      this.status = status;
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
    this.render();
    this.schedule();
  }

  render() {
    const ours = this.el.querySelector(".s-ours");
    const server = this.el.querySelector(".s-server");
    const connected = this.app.isConnected(this.connId);
    this.el.querySelector(".disconnect").hidden = !connected;
    if (!connected) {
      this.el.querySelector(".s-count").textContent = "";
      ours.innerHTML = '<div class="pad muted">Nothing running.</div>';
      server.innerHTML = `<div class="pad muted">Disconnected. <button class="ghost reconnect">${icons.plug}<span>Connect</span></button></div>`;
      server.querySelector(".reconnect").onclick = () => this.app.connect(this.conn);
      return;
    }
    if (this.error) {
      server.innerHTML = `<div class="pad error-text">${esc(this.error)}</div>`;
      return;
    }
    if (!this.data) {
      server.innerHTML = '<div class="pad muted"><span class="spinner"></span> Loading…</div>';
      return;
    }
    const conn = this.conn;
    const running = (this.status?.running || []).filter((r) => r.connId === this.connId);
    const open = this.status?.sessions?.[this.connId] || 0;
    ours.innerHTML = running.length
      ? `<table class="props"><thead><tr><th>Thread</th><th>Time</th><th>Statement</th><th></th></tr></thead><tbody>${running
          .map(
            (r) => `<tr class="${r.seconds > conn.timeoutMs / 2000 ? "slow" : ""}"><td class="mono">${r.threadId}</td><td class="num">${r.seconds.toFixed(1)}s</td>
            <td class="mono stmt">${esc(r.sql)}</td><td class="acts-cell"><button class="ghost danger-text" data-cancel="${esc(r.queryId)}">${icons.stop}<span>Stop</span></button></td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<div class="pad muted">Nothing running. ${open ? `${open} idle session${open > 1 ? "s" : ""} open (closed after a minute idle).` : "No session open."}</div>`;

    const me = (this.data.currentUser || "").split("@")[0];
    const hideIdle = this.el.querySelector(".hide-idle").checked;
    const mine = this.el.querySelector(".mine").checked;
    const all = this.data.threads;
    const rows = all.filter((t) => (!hideIdle || (t.command !== "Sleep" && t.command !== "Daemon")) && (!mine || t.user === me) && !t.self);
    this.el.querySelector(".s-count").textContent = `${rows.length} of ${all.length} threads`;
    const limit = conn.timeoutMs / 1000;
    server.innerHTML = rows.length
      ? `<table class="props"><thead><tr><th>Id</th><th>User</th><th>Host</th><th>DB</th><th>Command</th><th>Time</th><th>State</th><th>Statement</th><th class="acts-cell">Kill</th></tr></thead><tbody>${rows
          .map(
            (t) => `<tr class="${t.command !== "Sleep" && t.seconds >= limit ? "slow" : ""}">
            <td class="mono">${t.id}${t.ours ? ' <span class="badge" title="A session of Db Viewer">this app</span>' : ""}</td>
            <td>${esc(t.user)}</td><td class="faint">${esc(t.host)}</td><td>${esc(t.db || "")}</td>
            <td>${esc(t.command)}</td><td class="num">${duration(t.seconds)}</td><td class="faint">${esc(t.state || "")}</td>
            <td class="mono stmt" ${t.info ? `data-info="${t.id}" title="Click to see it whole"` : ""}>${t.info ? esc(t.info.slice(0, 200)) : ""}</td>
            <td class="acts-cell">${
              t.command === "Sleep" && !t.info
                ? `<button class="ghost icon" data-kill="${t.id}" title="Close this idle connection on the server (KILL)">${icons.close}</button>`
                : `<button class="ghost icon" data-killq="${t.id}" title="Kill the statement, keep the connection (KILL QUERY)">${icons.stop}</button>
                   <button class="ghost icon danger-text" data-kill="${t.id}" title="Kill the statement and close the connection (KILL)">${icons.close}</button>`
            }</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<div class="pad muted">No ${hideIdle ? "active " : ""}threads${mine ? ` of ${esc(me)}` : ""}.</div>`;
  }

  async click(e) {
    const b = e.target.closest("button[data-cancel], button[data-kill], button[data-killq], [data-info]");
    if (!b) return;
    if (b.dataset.info) {
      const t = this.data.threads.find((x) => String(x.id) === b.dataset.info);
      return modal({ title: `Thread ${t.id} · ${t.user}`, body: `<pre class="value-view">${esc(t.info)}</pre>`, wide: true, buttons: [{ label: "Copy", cls: "ghost", action: () => (octopus.copy(t.info), octopus.toast("Copied", "info")) }, { label: "Close", submit: true, cls: "primary" }] });
    }
    try {
      if (b.dataset.cancel) {
        await call("/cancel", { queryId: b.dataset.cancel });
      } else {
        const id = Number(b.dataset.kill || b.dataset.killq);
        const queryOnly = !!b.dataset.killq;
        const t = this.data.threads.find((x) => x.id === id);
        if (!t?.ours) {
          const what = queryOnly ? "stop its statement (KILL QUERY)" : "stop its statement and close the connection (KILL)";
          const ok = await confirmDialog(
            `Kill thread ${id}?`,
            `<p>This will ${what}. It belongs to <b>${esc(t?.user)}</b> from <b>${esc(t?.host)}</b>${t?.db ? ` on <b>${esc(t.db)}</b>` : ""}, running for ${duration(t?.seconds)}:</p>` +
              (t?.info ? `<pre class="value-view small">${esc(t.info)}</pre>` : "") +
              `<p class="muted small">An application holding this connection will see an error. A killed write is rolled back.</p>`,
            queryOnly ? "Kill query" : "Kill connection",
            true,
          );
          if (!ok) return;
        }
        await call("/kill", { conn: wire(this.conn), threadId: id, queryOnly });
        octopus.toast(`Killed ${queryOnly ? "the statement of " : ""}thread ${id}`, "success");
      }
    } catch (err) {
      octopus.toast(err.message, "error");
    }
    this.load();
  }

  serialize() {
    return { kind: "sessions", connId: this.connId };
  }

  dispose() {
    clearTimeout(this.timer);
  }
}
