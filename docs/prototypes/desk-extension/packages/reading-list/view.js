let port;
let identity;
const root = document.querySelector("main");
const send = (type, extra = {}) => port.postMessage({ type, ...identity, ...extra });
const put = (parent, tag, text, style) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (style) element.style.cssText = style; parent.append(element); return element; };
const render = ({ projection, theme }) => {
  const dark = theme === "dark";
  document.body.style.cssText = `margin:0;font:14px/1.55 Georgia,serif;color:${dark ? "#f4f4f5" : "#27211a"};background:${dark ? "#27272a" : "#fbf6ec"}`;
  root.replaceChildren();
  const object = projection.object;
  const card = put(root, "article", undefined, "padding:18px 20px;border-left:5px solid #b45309");
  card.dataset.customView = "reading-list";
  put(card, "div", `📖 On your shelf · ${object.rating ?? "unrated"}`, "font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#b45309");
  put(card, "h1", object.title, "font-size:21px;line-height:1.3;margin:8px 0");
  if (object.summary) put(card, "p", object.summary, "margin:0 0 10px;font-style:italic");
  if (object.tags?.length) put(card, "div", object.tags.map(tag => `#${tag}`).join("  "), "font-size:12px");
  send("resize", { height: Math.ceil(root.getBoundingClientRect().height) });
};
window.addEventListener("message", event => {
  if (event.source !== parent || port || event.data?.type !== "desk:init" || event.data.protocol !== "1.0.0" || event.ports.length !== 1) return;
  port = event.ports[0];
  identity = { instance: event.data.instance, release: event.data.release, protocol: event.data.protocol };
  port.onmessage = message => { if (message.data?.type === "host:projection") render(message.data); };
  port.start();
  send("ready");
});
