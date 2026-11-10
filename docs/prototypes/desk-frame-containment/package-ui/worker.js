const target = decodeURIComponent(self.location.hash.slice(1));
if (target) fetch(target, { mode: "no-cors" }).catch(() => {});
if (typeof self.postMessage === "function" && !self.registration) self.postMessage("ran");
