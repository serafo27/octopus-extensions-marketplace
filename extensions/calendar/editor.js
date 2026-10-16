// Popovers on events: the editor for local events, details for subscribed ones, a day's list,
// and the dialogs to add calendars and change settings.

import {
  S, PALETTE, colorOf, rerender, uid, upsertLocal, deleteLocal, localCalendars, allCalendars, addFeed,
  addLocalCalendar, saveSettings, meetingLink, nextColor, occurrencesIn,
} from "./store.js";
import { MENU_BAR_OPTIONS } from "./menubar.js";
import { h, icon, openPopover, closePopover, placePopover, openModal, closeModal } from "./ui.js";
import { DAY, MIN, addDays, startOfDay, toDateInput, toTimeInput, fromInputs, formatRange, formatDuration, format } from "./dates.js";

export function openOccurrence(o, anchor) {
  if (o.editable) openEditor(o, anchor);
  else openDetails(o, anchor);
}

// --- Editor -----------------------------------------------------------------------------------

const REPEATS = [
  ["", "Does not repeat"],
  ["DAILY", "Every day"],
  ["WEEKLY", "Every week"],
  ["MONTHLY", "Every month"],
  ["YEARLY", "Every year"],
];

/** `target` is an occurrence of a local event, or { draft: { start, end, allDay, calendarId } }. */
export function openEditor(target, anchor, { onClose } = {}) {
  const existing = target.draft ? null : S.local.find((e) => e.id === target.id);
  const base = existing
    ? { ...existing, start: new Date(existing.start), end: new Date(existing.end) }
    : { id: uid(), title: "", location: "", description: "", repeat: "", ...target.draft };
  const cals = localCalendars();
  const shownEnd = base.allDay ? addDays(base.end, -1) : base.end;

  const title = h("input", { class: "ed-title", placeholder: "New event", value: base.title });
  const allDay = h("input", { type: "checkbox", checked: !!base.allDay });
  const sDate = h("input", { type: "date", value: toDateInput(base.start) });
  const sTime = h("input", { type: "time", step: 900, value: toTimeInput(base.start) });
  const eDate = h("input", { type: "date", value: toDateInput(shownEnd) });
  const eTime = h("input", { type: "time", step: 900, value: toTimeInput(base.end) });
  const repeat = h("select", {}, REPEATS.map(([v, l]) => h("option", { value: v }, l)));
  repeat.value = base.repeat || "";
  const calSel = h("select", {}, cals.map(({ cal }) => h("option", { value: cal.id }, cal.name)));
  calSel.value = base.calendarId || cals[0]?.cal.id;
  const dot = h("span", { class: "cal-dot" });
  const paintDot = () => dot.style.setProperty("--c", colorOf(cals.find((x) => x.cal.id === calSel.value)?.cal));
  paintDot();
  calSel.addEventListener("change", paintDot);
  const location = h("input", { placeholder: "Add location or link", value: base.location || "" });
  const description = h("textarea", { rows: 3, placeholder: "Add description", value: base.description || "" });
  const durationHint = h("span", { class: "faint ed-dur" });
  const err = h("div", { class: "ed-err" });

  const sync = () => {
    sTime.hidden = eTime.hidden = allDay.checked;
    if (allDay.checked) durationHint.textContent = "";
    else {
      const ms = fromInputs(eDate.value, eTime.value) - fromInputs(sDate.value, sTime.value);
      durationHint.textContent = ms > 0 ? formatDuration(ms) : "";
    }
  };
  allDay.addEventListener("change", sync);
  // Moving the start keeps the duration, like other calendars.
  let lastStart = fromInputs(sDate.value, sTime.value);
  const onStart = () => {
    const ns = fromInputs(sDate.value, sTime.value);
    if (isNaN(ns)) return;
    const ne = new Date(+fromInputs(eDate.value, eTime.value) + (ns - lastStart));
    lastStart = ns;
    eDate.value = toDateInput(ne);
    eTime.value = toTimeInput(ne);
    sync();
  };
  sDate.addEventListener("change", onStart);
  sTime.addEventListener("change", onStart);
  eDate.addEventListener("change", sync);
  eTime.addEventListener("change", sync);

  const save = () => {
    let start;
    let end;
    if (allDay.checked) {
      start = fromInputs(sDate.value, "00:00");
      end = addDays(fromInputs(eDate.value, "00:00"), 1);
    } else {
      start = fromInputs(sDate.value, sTime.value);
      end = fromInputs(eDate.value, eTime.value);
    }
    if (isNaN(start) || isNaN(end)) return (err.textContent = "Check the dates.");
    if (end <= start) return (err.textContent = "The end must be after the start.");
    upsertLocal({
      id: base.id,
      calendarId: calSel.value,
      title: title.value.trim() || "(No title)",
      start: +start,
      end: +end,
      allDay: allDay.checked,
      repeat: repeat.value || null,
      location: location.value.trim(),
      description: description.value.trim(),
    });
    closePopover();
    rerender();
  };

  for (const el of [title, location]) el.addEventListener("keydown", (e) => e.key === "Enter" && save());
  description.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && save());

  const form = h(
    "div",
    { class: "editor" },
    title,
    h("div", { class: "ed-row" }, icon("clock"), h("div", { class: "ed-when" },
      h("div", { class: "ed-line" }, h("span", { class: "faint ed-lbl" }, "Starts"), sDate, sTime),
      h("div", { class: "ed-line" }, h("span", { class: "faint ed-lbl" }, "Ends"), eDate, eTime),
      h("div", { class: "ed-line" }, h("label", { class: "check" }, allDay, "All day"), durationHint),
    )),
    h("div", { class: "ed-row" }, icon("repeat"), repeat),
    h("div", { class: "ed-row" }, icon("calendar"), h("div", { class: "ed-line grow" }, dot, calSel)),
    h("div", { class: "ed-row" }, icon("pin"), location),
    h("div", { class: "ed-row top" }, icon("text"), description),
    existing?.repeat && h("div", { class: "faint ed-note" }, "Changes apply to every occurrence."),
    err,
    h(
      "div",
      { class: "ed-actions" },
      existing &&
        h("button", { class: "ghost icon-btn danger", title: "Delete (⌫)", onclick: () => (deleteLocal(base.id), closePopover(), rerender()) }, icon("trash")),
      existing &&
        h("button", {
          class: "ghost icon-btn",
          title: "Duplicate",
          onclick: () => {
            upsertLocal({ ...existing, id: uid(), title: `${existing.title}` });
            closePopover();
            rerender();
          },
        }, icon("copy")),
      h("span", { class: "spacer" }),
      h("button", { class: "ghost", onclick: () => closePopover() }, "Cancel"),
      h("button", { class: "primary", onclick: save }, existing ? "Save" : "Create"),
    ),
  );
  sync();
  openPopover(anchor, form, { onClose, width: 380 });
  S.editing = existing ? base.id : null;
  requestAnimationFrame(() => {
    title.focus();
    title.select();
  });
}

// --- Details (read-only events) ---------------------------------------------------------------

function plainText(s) {
  if (!s) return "";
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  const doc = new DOMParser().parseFromString(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n"), "text/html");
  return doc.body.textContent || "";
}

function linkified(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const url = m[0].replace(/[).,;]+$/, "");
    out.push(h("a", { href: "#", onclick: (e) => (e.preventDefault(), octopus.openUrl(url)) }, url));
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}

const STATUS = { ACCEPTED: "✓", DECLINED: "✕", TENTATIVE: "?", "NEEDS-ACTION": "" };

export function openDetails(o, anchor) {
  const link = meetingLink(o);
  const desc = plainText(o.description).trim();
  const people = o.attendees || [];
  const copyText = [o.title, formatRange(o.start, o.end, o.allDay), o.location, link].filter(Boolean).join("\n");
  const el = h(
    "div",
    { class: "details", style: { "--c": o.color } },
    h("div", { class: "dt-head" }, h("span", { class: "dt-swatch" }), h("div", { class: "dt-title" }, o.title)),
    h("div", { class: "dt-row" }, icon("clock"), h("div", {}, formatRange(o.start, o.end, o.allDay), o.recurring && h("div", { class: "faint" }, "Repeats"))),
    link && h("div", { class: "dt-row" }, icon("video"), h("button", { class: "primary", onclick: () => octopus.openUrl(link) }, "Join meeting"), h("span", { class: "faint dt-host" }, new URL(link).host)),
    o.location && o.location !== link && h("div", { class: "dt-row" }, icon("pin"), h("div", { class: "dt-text" }, linkified(o.location))),
    h("div", { class: "dt-row" }, icon("calendar"), h("div", {}, o.cal.name, h("span", { class: "faint" }, ` · ${o.account.name}`))),
    (o.organizer || people.length > 0) &&
      h(
        "div",
        { class: "dt-row top" },
        icon("people"),
        h(
          "div",
          { class: "dt-people" },
          o.organizer && h("div", {}, o.organizer.name || o.organizer.email, h("span", { class: "faint" }, " · organizer")),
          people.slice(0, 12).map((p) =>
            h("div", { class: `person ${(p.status || "").toLowerCase()}` }, h("span", { class: "st" }, STATUS[p.status] ?? ""), p.name || p.email),
          ),
          people.length > 12 && h("div", { class: "faint" }, `and ${people.length - 12} more`),
        ),
      ),
    desc && h("div", { class: "dt-row top" }, icon("text"), h("div", { class: "dt-desc" }, linkified(desc))),
    h(
      "div",
      { class: "ed-actions" },
      h("button", { class: "ghost icon-btn", title: "Copy details", onclick: () => (octopus.copy(copyText), octopus.toast("Copied", "info")) }, icon("copy")),
      o.url && h("button", { class: "ghost icon-btn", title: "Open in browser", onclick: () => octopus.openUrl(o.url) }, icon("link")),
      h("span", { class: "spacer" }),
      h("span", { class: "faint" }, "Read only"),
      h(
        "button",
        {
          class: "ghost",
          title: "Copy into a local calendar, where you can edit it",
          onclick: () => {
            const cal = localCalendars()[0]?.cal;
            if (!cal) return;
            upsertLocal({ id: uid(), calendarId: cal.id, title: o.title, start: +o.start, end: +o.end, allDay: o.allDay, location: o.location, description: desc, repeat: null });
            closePopover();
            rerender();
            octopus.toast(`Copied to ${cal.name}`, "success");
          },
        },
        "Copy to my calendar",
      ),
    ),
  );
  openPopover(anchor, el, { width: 360 });
}

// --- A day's list -----------------------------------------------------------------------------

export function openDayList(day, anchor) {
  const occs = occurrencesIn(day, addDays(day, 1));
  const el = h(
    "div",
    { class: "daylist" },
    h("div", { class: "dl-head" }, h("span", { class: "dl-num" }, day.getDate()), format.long(day)),
    occs.map((o) =>
      h(
        "div",
        { class: "dl-item", style: { "--c": o.color }, onclick: (e) => openOccurrence(o, anchor) },
        h("span", { class: "m-dot" }),
        h("span", { class: "faint dl-time" }, o.allDay ? "All day" : format.time(o.start)),
        h("span", { class: "dl-title" }, o.title),
      ),
    ),
  );
  openPopover(anchor, el, { width: 280 });
}

// --- Add a calendar ---------------------------------------------------------------------------

const PROVIDERS = {
  google: {
    label: "Google",
    placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
    help: [
      "Open calendar.google.com → ⚙ Settings.",
      "Under “Settings for my calendars”, pick the calendar.",
      "Integrate calendar → copy the “Secret address in iCal format”.",
    ],
    note: "Work (Google Workspace) accounts: if the secret address is missing, your admin has turned it off.",
    open: "https://calendar.google.com/calendar/r/settings",
  },
  outlook: {
    label: "Outlook / Microsoft 365",
    placeholder: "https://outlook.office365.com/owa/calendar/…/calendar.ics",
    help: [
      "Open Outlook on the web → ⚙ Settings → Calendar → Shared calendars.",
      "Under “Publish a calendar”, pick the calendar and “Can view all details”, then Publish.",
      "Copy the ICS link.",
    ],
    open: "https://outlook.office.com/calendar/options/calendar/SharedCalendars",
  },
  icloud: {
    label: "iCloud",
    placeholder: "webcal://p01-caldav.icloud.com/published/2/…",
    help: [
      "In the Calendar app (or icloud.com/calendar), share the calendar.",
      "Turn on “Public Calendar” and copy the link.",
    ],
    note: "Each iCloud link lives on its own host (p01…p2xx-caldav.icloud.com): the first time, Octopus has to allow it.",
    open: "https://www.icloud.com/calendar/",
  },
  other: {
    label: "Other (ICS)",
    placeholder: "https://…/calendar.ics or webcal://…",
    help: ["Any public or secret iCalendar (.ics) address: iCloud public calendars, Fastmail, holidays, sports…"],
  },
};

export function openAddCalendar(provider = "google") {
  const icsAccounts = S.accounts.filter((a) => a.kind === "ics").map((a) => a.name);
  let color = nextColor();
  const account = h("input", { placeholder: "e.g. name@gmail.com", list: "acc-names", value: icsAccounts[0] || "" });
  const url = h("input", { class: "mono", placeholder: PROVIDERS[provider].placeholder });
  const name = h("input", { placeholder: "Taken from the calendar if empty" });
  const err = h("div", { class: "ed-err" });
  const add = h("button", { class: "primary" }, "Add calendar");
  const help = h("ol", { class: "help" });
  const note = h("div", { class: "muted" });
  const openLink = h("a", { href: "#" });
  const tabs = h("div", { class: "seg" });
  // Swatches are made once and only change class: rebuilding them mid-click, inside a <label>,
  // made WebKit pass the click on to the first swatch.
  const swatchEls = PALETTE.map((c, i) => h("button", { type: "button", class: "swatch", style: { "--c": c }, title: "Colour", onclick: () => ((color = i), paintSwatches()) }));
  const swatches = h("div", { class: "swatches" }, swatchEls);
  const paintSwatches = () => swatchEls.forEach((el, i) => el.classList.toggle("on", i === color));
  const setProvider = (p) => {
    provider = p;
    url.placeholder = PROVIDERS[p].placeholder;
    help.replaceChildren(...PROVIDERS[p].help.map((t) => h("li", {}, t)));
    note.textContent = PROVIDERS[p].note || "";
    note.hidden = !PROVIDERS[p].note;
    openLink.hidden = !PROVIDERS[p].open;
    openLink.textContent = `Open ${PROVIDERS[p].label} settings`;
    openLink.onclick = (e) => (e.preventDefault(), octopus.openUrl(PROVIDERS[p].open));
    tabs.replaceChildren(
      ...Object.entries(PROVIDERS).map(([k, v]) => h("button", { class: k === p ? "on" : "", onclick: () => setProvider(k) }, v.label)),
    );
  };
  setProvider(provider);
  paintSwatches();

  add.addEventListener("click", async () => {
    err.textContent = "";
    if (!url.value.trim()) return (err.textContent = "Paste the calendar's address.");
    if (!account.value.trim()) return (err.textContent = "Name the account, e.g. its email address.");
    add.disabled = true;
    add.replaceChildren(h("span", { class: "spinner" }), " Checking…");
    try {
      const cal = await addFeed({ accountName: account.value, url: url.value, name: name.value, color });
      closeModal();
      rerender();
      octopus.toast(`${cal.name} added`, "success");
    } catch (e) {
      err.replaceChildren(
        e.message,
        e.host ? h("button", { class: "ghost sm", onclick: () => (octopus.copy(`Allow https://${e.host} in the Calendar extension`), octopus.toast("Copied: paste it to Claude", "info")) }, icon("copy", 12), " Copy request") : "",
      );
      add.disabled = false;
      add.textContent = "Add calendar";
    }
  });

  openModal(
    "Add a calendar",
    h(
      "div",
      { class: "form" },
      tabs,
      h("div", { class: "help-box" }, help, openLink, note),
      h("label", {}, h("span", {}, "Account"), account, h("datalist", { id: "acc-names" }, icsAccounts.map((n) => h("option", { value: n })))),
      h("label", {}, h("span", {}, "Calendar address"), url),
      h("label", {}, h("span", {}, "Name"), name),
      h("div", { class: "field" }, h("span", {}, "Colour"), swatches),
      h("div", { class: "faint" }, "Subscribed calendars are read only; they refresh every 15 minutes. The secret address stays in Octopus."),
      err,
      h("div", { class: "ed-actions" }, h("span", { class: "spacer" }), h("button", { class: "ghost", onclick: closeModal }, "Cancel"), add),
    ),
    { width: 520 },
  );
  url.focus();
}

export function openNewLocalCalendar() {
  const name = h("input", { placeholder: "e.g. Focus time" });
  const create = () => {
    if (!name.value.trim()) return;
    addLocalCalendar(name.value.trim());
    closeModal();
    rerender();
  };
  name.addEventListener("keydown", (e) => e.key === "Enter" && create());
  openModal(
    "New local calendar",
    h(
      "div",
      { class: "form" },
      h("label", {}, h("span", {}, "Name"), name),
      h("div", { class: "ed-actions" }, h("span", { class: "spacer" }), h("button", { class: "ghost", onclick: closeModal }, "Cancel"), h("button", { class: "primary", onclick: create }, "Create")),
    ),
    { width: 380 },
  );
}

// --- Settings ---------------------------------------------------------------------------------

export function openSettings(anchor) {
  const st = S.settings;
  const select = (value, options, onChange) => {
    const el = h("select", {}, options.map(([v, l]) => h("option", { value: String(v) }, l)));
    el.value = String(value);
    el.addEventListener("change", () => (onChange(el.value), saveSettings(), rerender()));
    return el;
  };
  // A checkbox bound to a boolean setting (inverted: checked means the setting is off).
  const toggle = (key, inverted) => {
    const el = h("input", { type: "checkbox", checked: inverted ? !st[key] : !!st[key] });
    el.addEventListener("change", () => ((st[key] = inverted ? !el.checked : el.checked), saveSettings(), rerender()));
    return el;
  };
  const weekends = h("input", { type: "checkbox", checked: !st.hideWeekends });
  weekends.addEventListener("change", () => ((st.hideWeekends = !weekends.checked), saveSettings(), rerender()));
  openPopover(
    anchor,
    h(
      "div",
      { class: "form settings" },
      h("label", {}, h("span", {}, "Week starts on"), select(st.weekStart, [[1, "Monday"], [0, "Sunday"], [6, "Saturday"]], (v) => (st.weekStart = +v))),
      h("label", {}, h("span", {}, "Default duration"), select(st.defaultDuration, [[15, "15 min"], [30, "30 min"], [45, "45 min"], [60, "1 hour"], [90, "1.5 hours"], [120, "2 hours"]], (v) => (st.defaultDuration = +v))),
      h("label", {}, h("span", {}, "Hour height"), select(st.hourHeight, [[36, "Compact"], [48, "Comfortable"], [64, "Spacious"]], (v) => (st.hourHeight = +v))),
      h("label", { class: "check" }, weekends, "Show weekends"),
      h("label", { class: "check" }, toggle("hideDeclined", true), "Show declined events"),
      h("div", { class: "settings-head" }, "Notifications"),
      notifySettings(),
      autoJoinSettings(),
      h("div", { class: "settings-head" }, "Menu bar"),
      menuBarSettings(),
    ),
    { width: 260, prefer: "below" },
  );
}

/** A boolean setting with how many minutes before an event it acts: a checkbox and a select. */
function leadSettings(onKey, leadKey, checkLabel, selectLabel, title) {
  const st = S.settings;
  const on = h("input", { type: "checkbox", checked: !!st[onKey] });
  const when = h("select", { disabled: !st[onKey] }, [1, 2, 3, 5, 10].map((v) => h("option", { value: String(v) }, `${v} min before`)));
  when.value = String(st[leadKey] ?? 1);
  const apply = () => {
    st[onKey] = on.checked;
    st[leadKey] = +when.value;
    when.disabled = !on.checked;
    saveSettings();
    rerender();
  };
  on.addEventListener("change", apply);
  when.addEventListener("change", apply);
  return h(
    "div",
    { class: "form" },
    h("label", { class: "check", title }, on, checkLabel),
    h("label", {}, h("span", {}, selectLabel), when),
  );
}

/** Notifications: on or off, and how many minutes before an event starts. */
const notifySettings = () => leadSettings("notify", "notifyLead", "Notify before events", "Notify");

/** Auto join: on or off, and how many minutes before a meeting starts its call link opens. */
const autoJoinSettings = () =>
  leadSettings("autoJoin", "autoJoinLead", "Auto join meetings I accepted", "Join", "Opens the call link of meetings you accepted, as the Join button does");

/** The next meeting in the Mac's menu bar: on or off, and from how long before it starts. */
function menuBarSettings() {
  const st = S.settings;
  if (!octopus.statusBar) {
    return h("div", { class: "faint settings-note" }, "Needs a newer Octopus (0.2.1-preview.11 or later).");
  }
  const lead = st.menuBarLead ?? 60; // remembered while it's off
  const on = h("input", { type: "checkbox", checked: !!st.menuBar });
  const when = h("select", { disabled: !st.menuBar }, MENU_BAR_OPTIONS.map(([v, l]) => h("option", { value: String(v) }, l)));
  when.value = String(st.menuBar || lead);
  const apply = () => {
    st.menuBarLead = +when.value;
    st.menuBar = on.checked ? +when.value : 0;
    when.disabled = !on.checked;
    saveSettings();
    rerender();
  };
  on.addEventListener("change", apply);
  when.addEventListener("change", apply);
  return h(
    "div",
    { class: "form" },
    h("label", { class: "check" }, on, "Show the next meeting in the menu bar"),
    h("label", {}, h("span", {}, "Show it"), when),
  );
}

export function openShortcuts() {
  const keys = [
    ["T", "Today"], ["D W M A", "Day, week, month, agenda"], ["J  →", "Next"], ["K  ←", "Previous"],
    ["C", "New event"], ["/  ⌘F", "Search"], ["R", "Refresh calendars"], ["⌫", "Delete the event being edited"],
    ["Esc", "Close"], ["⌘↵", "Save from the description"], ["?", "This list"],
  ];
  openModal("Keyboard shortcuts", h("div", { class: "keys" }, keys.flatMap(([k, l]) => [h("kbd", {}, k), h("span", {}, l)])), { width: 340 });
}
