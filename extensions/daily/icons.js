// Line icons on a 16×16 grid, drawn in the current colour. Weather icons fill their sun and drops
// with the theme's colours through classes (`.i-sun`, `.i-drop`) set in style.css.

const NS = "http://www.w3.org/2000/svg";

const P = {
  gear: [["path", { d: "M12.95 6.77L14.45 7.24L14.45 8.76L12.95 9.23L12.37 10.63L13.1 12.02L12.02 13.1L10.63 12.37L9.23 12.95L8.76 14.45L7.24 14.45L6.77 12.95L5.37 12.37L3.98 13.1L2.9 12.02L3.63 10.63L3.05 9.23L1.55 8.76L1.55 7.24L3.05 6.77L3.63 5.37L2.9 3.98L3.98 2.9L5.37 3.63L6.77 3.05L7.24 1.55L8.76 1.55L9.23 3.05L10.63 3.63L12.02 2.9L13.1 3.98L12.37 5.37Z" }], ["circle", { cx: 8, cy: 8, r: 2 }]],
  refresh: [["path", { d: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" }]],
  grip: [["path", { d: "M6 4h0M10 4h0M6 8h0M10 8h0M6 12h0M10 12h0" }]],
  close: [["path", { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" }]],
  detach: [["path", { d: "M9.5 2.5h4v4M13.5 2.5L8 8M11.5 9.5v3.5h-9v-9h3.5" }]],
  plus: [["path", { d: "M8 3.5v9M3.5 8h9" }]],
  book: [["path", { d: "M8 4.5C6.5 3.4 4.6 3 2.5 3v9.5c2.1 0 4 .4 5.5 1.5 1.5-1.1 3.4-1.5 5.5-1.5V3c-2.1 0-4 .4-5.5 1.5zM8 4.5V14" }]],
  copy: [["path", { d: "M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7z" }]],
  join: [["path", { d: "M2.5 5h7v6h-7zM9.5 7.2l4-2.2v6l-4-2.2" }]],
  clock: [["circle", { cx: 8, cy: 8, r: 5.5 }], ["path", { d: "M8 5v3l2 1.5" }]],
  calendar: [["rect", { x: 2.5, y: 3.5, width: 11, height: 10, rx: 1.5 }], ["path", { d: "M2.5 6.5h11M5.5 2v3M10.5 2v3" }]],
  check: [["rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5 }], ["path", { d: "m5.5 8 2 2 3.5-4" }]],
  focus: [["circle", { cx: 8, cy: 8, r: 5.5 }], ["circle", { cx: 8, cy: 8, r: 2 }]],
  people: [["circle", { cx: 6, cy: 6, r: 2.2 }], ["path", { d: "M2.5 13c.4-2 1.8-3 3.5-3s3.1 1 3.5 3M10.5 4.2a2 2 0 1 1 0 3.8M11.5 10.2c1 .4 1.8 1.3 2 2.8" }]],
  news: [["path", { d: "M3.5 3.5h7v9h-6a1 1 0 0 1-1-1v-8ZM10.5 6h2v5.5a1 1 0 0 1-2 0M5.5 6h3M5.5 8.5h3M5.5 11h2" }]],
  week: [["rect", { x: 2.5, y: 3.5, width: 11, height: 10, rx: 1.5 }], ["path", { d: "M2.5 6.5h11M5.5 9h1M7.5 9h1M9.5 9h1M5.5 11h1" }]],
  wind: [["path", { d: "M2.5 6h7a2 2 0 1 0-2-2M2.5 10h9a2 2 0 1 1-2 2" }]],
  drop: [["path", { d: "M8 2.5s4 4.2 4 7a4 4 0 0 1-8 0c0-2.8 4-7 4-7Z" }]],
  // Weather
  sun: [["circle", { class: "i-sun", cx: 8, cy: 8, r: 3 }], ["path", { d: "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" }]],
  moon: [["path", { class: "i-moon", d: "M12.5 9.5A5 5 0 0 1 6.5 3.5a5 5 0 1 0 6 6Z" }]],
  partly: [["circle", { class: "i-sun", cx: 6, cy: 6, r: 2.5 }], ["path", { d: "M6 1.5v1M1.5 6h1M2.8 2.8l.7.7M9.2 2.8l-.7.7" }], ["path", { class: "i-cloud", d: "M5 13.5h6.5a2.5 2.5 0 0 0 0-5 3.5 3.5 0 0 0-6.6 1A2 2 0 0 0 5 13.5Z" }]],
  partlyNight: [["path", { class: "i-moon", d: "M8.5 5.8A3.5 3.5 0 0 1 4.2 1.5a3.5 3.5 0 1 0 4.3 4.3Z" }], ["path", { class: "i-cloud", d: "M5 13.5h6.5a2.5 2.5 0 0 0 0-5 3.5 3.5 0 0 0-6.6 1A2 2 0 0 0 5 13.5Z" }]],
  cloudy: [["path", { class: "i-cloud", d: "M4.5 12.5h7a3 3 0 0 0 0-6 4 4 0 0 0-7.6 1.2A2.4 2.4 0 0 0 4.5 12.5Z" }]],
  fog: [["path", { class: "i-cloud", d: "M4.5 9.5h7a3 3 0 0 0 0-6 4 4 0 0 0-7.6 1.2A2.4 2.4 0 0 0 4.5 9.5Z" }], ["path", { d: "M3 12h10M5 14h6" }]],
  rain: [["path", { class: "i-cloud", d: "M4.5 9.5h7a3 3 0 0 0 0-6 4 4 0 0 0-7.6 1.2A2.4 2.4 0 0 0 4.5 9.5Z" }], ["path", { class: "i-drop", d: "M5.5 11.5l-1 2M8.5 11.5l-1 2M11.5 11.5l-1 2" }]],
  snow: [["path", { class: "i-cloud", d: "M4.5 9.5h7a3 3 0 0 0 0-6 4 4 0 0 0-7.6 1.2A2.4 2.4 0 0 0 4.5 9.5Z" }], ["path", { d: "M5 12.5h.01M8 13.5h.01M11 12.5h.01M6.5 14.5h.01M9.5 14.5h.01" }]],
  storm: [["path", { class: "i-cloud", d: "M4.5 9.5h7a3 3 0 0 0 0-6 4 4 0 0 0-7.6 1.2A2.4 2.4 0 0 0 4.5 9.5Z" }], ["path", { class: "i-bolt", d: "M8.5 10 7 12.5h2L7.5 15" }]],
};

export function icon(name, size = 16, cls = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon ${cls}`.trim());
  for (const [tag, attrs] of P[name] || []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** The icon for a WMO weather code, by day or night. */
export function weatherIcon(code, isDay = true, size = 20) {
  let name = "cloudy";
  if (code <= 1) name = isDay ? "sun" : "moon";
  else if (code === 2) name = isDay ? "partly" : "partlyNight";
  else if (code === 3) name = "cloudy";
  else if (code === 45 || code === 48) name = "fog";
  else if (code >= 51 && code <= 67) name = "rain";
  else if (code >= 71 && code <= 77) name = "snow";
  else if (code >= 80 && code <= 82) name = "rain";
  else if (code === 85 || code === 86) name = "snow";
  else if (code >= 95) name = "storm";
  return icon(name, size, "wx-icon");
}
