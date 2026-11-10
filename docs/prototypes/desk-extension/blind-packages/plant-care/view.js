let port;
let identity;

const send = message => port.postMessage({ ...message, ...identity });
const setText = (id, value) => { document.getElementById(id).textContent = value; };

function render(object) {
  setText("name", object.name);
  setText("species", object.species);
  setText("room", object.roomName);
  setText("due", object.nextWaterDue);
  setText("interval", `${object.wateringIntervalHours / 24} days`);
  setText("note", object.careNote);
  document.getElementById("plant").hidden = false;
  send({ type: "resize", height: document.documentElement.scrollHeight });
}

window.addEventListener("message", event => {
  if (event.source !== parent) return;
  const init = event.data;
  if (init?.type !== "desk:init" || init.protocol !== "1.0.0" || event.ports.length !== 1) return;
  port = event.ports[0];
  identity = { instance: init.instance, release: init.release, protocol: init.protocol };
  port.onmessage = message => {
    if (message.data?.type === "host:projection") render(message.data.projection.object);
  };
  port.start();
  send({ type: "ready" });
});
