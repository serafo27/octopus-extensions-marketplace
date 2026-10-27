// Editable key/value table (params, headers, form fields, variables), with a bulk-edit mode.

import { h } from "./ui.js";
import { varField } from "./varfield.js";

/**
 * rows: the array it edits in place ({ key, value, enabled }). onChange() after every edit.
 * A trailing empty row becomes a real one as soon as something is typed in it.
 * `vars`: a variable context (see varfield.js) to highlight {{variables}} in keys and values.
 */
export function kvEditor(rows, onChange, { keyPh = "Key", valuePh = "Value", secret = false, bulk = true, vars = null } = {}) {
  const root = h("div", { class: "kv" });
  let bulkMode = false;

  const render = () => {
    root.replaceChildren();
    if (bulk)
      root.append(
        h(
          "div",
          { class: "kv-head" },
          h("span", { class: "faint" }, bulkMode ? "One per line: key: value  (// to disable)" : ""),
          h("button", { class: "ghost small", onclick: toggleBulk }, bulkMode ? "Key-value edit" : "Bulk edit"),
        ),
      );
    if (bulkMode) {
      const ta = h("textarea", { class: "mono kv-bulk", spellcheck: false, rows: Math.max(6, rows.length + 2) });
      ta.value = rows.map((r) => (r.enabled === false ? "//" : "") + r.key + ": " + r.value).join("\n");
      ta.addEventListener("input", () => {
        const next = ta.value
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => {
            const off = l.startsWith("//");
            if (off) l = l.slice(2);
            const i = l.indexOf(":");
            return { key: (i < 0 ? l : l.slice(0, i)).trim(), value: i < 0 ? "" : l.slice(i + 1).trim(), enabled: !off };
          });
        rows.splice(0, rows.length, ...next);
        onChange();
      });
      root.append(ta);
      return;
    }
    const body = h("tbody");
    for (const r of rows) body.append(rowEl(r, body));
    body.append(rowEl(null, body));
    root.append(h("table", { class: "kv-table" }, body));
  };

  const toggleBulk = () => {
    bulkMode = !bulkMode;
    render();
  };

  const rowEl = (row, body) => {
    const tr = h("tr", { class: row ? "" : "ghost" });
    const ensure = () => {
      if (row) return;
      row = { key: "", value: "", enabled: true };
      rows.push(row);
      tr.classList.remove("ghost");
      check.disabled = false;
      check.checked = true;
      del.hidden = false;
      body.append(rowEl(null, body));
    };
    const check = h("input", {
      type: "checkbox",
      checked: row ? row.enabled !== false : false,
      disabled: !row,
      onchange: () => {
        row.enabled = check.checked;
        tr.classList.toggle("off", !check.checked);
        onChange();
      },
    });
    const field = (name, ph) => {
      const input = h("input", {
        type: secret && name === "value" ? "password" : "text",
        value: row?.[name] ?? "",
        placeholder: ph,
        spellcheck: false,
        oninput: () => {
          ensure();
          row[name] = input.value;
          onChange();
        },
      });
      if (secret && name === "value") {
        input.addEventListener("focus", () => (input.type = "text"));
        input.addEventListener("blur", () => (input.type = "password"));
      }
      return vars ? varField(input, vars) : input;
    };
    const del = h(
      "button",
      {
        class: "ghost icon small",
        title: "Remove",
        hidden: !row,
        onclick: () => {
          rows.splice(rows.indexOf(row), 1);
          tr.remove();
          onChange();
        },
      },
      "×",
    );
    if (row?.enabled === false) tr.classList.add("off");
    tr.append(h("td", { class: "kv-check" }, check), h("td", {}, field("key", keyPh)), h("td", {}, field("value", valuePh)), h("td", { class: "kv-del" }, del));
    return tr;
  };

  render();
  return root;
}
