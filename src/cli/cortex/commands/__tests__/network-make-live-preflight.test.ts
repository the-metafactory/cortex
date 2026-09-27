/**
 * cortex#2533 — the pure make-live pre-flight helpers: JetStream store_dir
 * parsing, `$G` store reporting + move target, include inlining, and the
 * boot-test config render (which must neutralise every listener and outbound
 * URL while KEEPING the leaf remote `account:` line the boot test exists for).
 */
import { describe, test, expect } from "bun:test";
import { dirname, join } from "path";

import {
  inlineConfigIncludes,
  parseJetStreamStoreDecl,
  describeGStoreStreams,
  formatBytes,
  gStoreMoveTarget,
  renderBootTestConfig,
} from "../network-make-live-preflight";
import type { ConfigFileReader } from "../network-bus-safety";

const FED = "A" + "F".repeat(55);

function memReader(files: Record<string, string>): ConfigFileReader {
  return { read: (p) => files[p], dirname, join };
}

describe("parseJetStreamStoreDecl", () => {
  test("block with a quoted store_dir", () => {
    expect(parseJetStreamStoreDecl(`jetstream {\n  store_dir: "/data/nats"\n  max_mem: 64mb\n}\n`)).toEqual({
      jetstream: true,
      storeDir: "/data/nats",
    });
  });

  test("one-line block, `=` separator, bare value", () => {
    expect(parseJetStreamStoreDecl(`jetstream { store_dir = /data/js }`)).toEqual({
      jetstream: true,
      storeDir: "/data/js",
    });
  });

  test("`jetstream: enabled` shorthand ⇒ on, no declared store_dir", () => {
    expect(parseJetStreamStoreDecl(`listen: 4222\njetstream: enabled\n`)).toEqual({
      jetstream: true,
      storeDir: undefined,
    });
  });

  test("no jetstream key, or `jetstream: disabled` ⇒ off", () => {
    expect(parseJetStreamStoreDecl(`listen: 4222\n`)).toEqual({ jetstream: false });
    expect(parseJetStreamStoreDecl(`jetstream: disabled\n`)).toEqual({ jetstream: false });
  });

  test("a commented-out jetstream block is ignored", () => {
    expect(parseJetStreamStoreDecl(`# jetstream { store_dir: "/x" }\nlisten: 4222\n`)).toEqual({
      jetstream: false,
    });
  });
});

describe("$G store reporting + move target", () => {
  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });

  test("describeGStoreStreams lists names + sizes", () => {
    expect(
      describeGStoreStreams([
        { name: "ORDERS", bytes: 2048 },
        { name: "EVENTS", bytes: undefined },
      ]),
    ).toBe("ORDERS (2.0 KiB), EVENTS (size unknown)");
    expect(describeGStoreStreams([])).toBe("no stream directories");
  });

  test("the move target sits beside jetstream/, never inside it", () => {
    const target = gStoreMoveTarget("/data/nats", "20260927T081500Z");
    expect(target).toBe("/data/nats/G-moved-aside-20260927T081500Z");
    expect(target.startsWith("/data/nats/jetstream/")).toBe(false);
  });
});

describe("inlineConfigIncludes", () => {
  test("inlines relative + absolute includes recursively, using the snapshot text for the root", () => {
    const io = memReader({
      "/cfg/leaf-net.conf": `leafnodes {\n  include "remotes.conf"\n}\n`,
      "/cfg/remotes.conf": `remotes: [ { url: "nats-leaf://hub.example.invalid:7422", account: "${FED}" } ]\n`,
      "/abs/extra.conf": `max_payload: 1MB\n`,
    });
    const res = inlineConfigIncludes(
      "/cfg/bus.conf",
      `listen: 4222\ninclude "leaf-net.conf"\ninclude /abs/extra.conf\n`,
      io,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(`account: "${FED}"`);
    expect(res.text).toContain("max_payload: 1MB");
    expect(res.text).not.toMatch(/^\s*include/m);
  });

  test("a missing include is a failure naming the path", () => {
    const res = inlineConfigIncludes("/cfg/bus.conf", `include "gone.conf"\n`, memReader({}));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("/cfg/gone.conf");
  });

  test("an include cycle is a failure, not a hang", () => {
    const io = memReader({ "/cfg/a.conf": `include "b.conf"\n`, "/cfg/b.conf": `include "a.conf"\n` });
    const res = inlineConfigIncludes("/cfg/a.conf", `include "b.conf"\n`, io);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("cycle");
  });
});

describe("renderBootTestConfig", () => {
  const OPTS = { monitorPort: 18123, deadPort: 19001, scratchDir: "/scratch/bt" };

  const SNAPSHOT = [
    `server_name: "work-alice"`,
    `listen: "127.0.0.1:4222"`,
    `http: "127.0.0.1:8222"`,
    `pid_file: "/var/run/nats.pid"`,
    `log_file: "/var/log/nats.log"`,
    `jetstream { store_dir: "/data/nats", max_mem: 64mb, domain: "work-alice" }`,
    `leafnodes {`,
    `  port: 7422`,
    `  remotes: [`,
    `    { url: "nats-leaf://hub.example.invalid:7422", account: "${FED}" }`,
    `    { urls: ["tls://hub-b.example.invalid:7422", "wss://hub-c.example.invalid:443"], account: "${FED}" }`,
    `  ]`,
    `}`,
    `cluster { name: "c1", listen: "0.0.0.0:6222", routes: ["nats-route://peer.example.invalid:6222"] }`,
    `websocket { host: "0.0.0.0", port: 8080, no_tls: true }`,
    `resolver { type: full, dir: "/data/jwt" }`,
    "",
  ].join("\n");

  test("keeps every leaf remote `account:` line (the check the boot test exists for)", () => {
    const { conf } = renderBootTestConfig(SNAPSHOT, OPTS);
    expect(conf.match(new RegExp(`account: "${FED}"`, "g"))?.length).toBe(2);
  });

  test("points every outbound URL at the dead loopback port — never the real hub/peer", () => {
    const { conf } = renderBootTestConfig(SNAPSHOT, OPTS);
    expect(conf).not.toContain("example.invalid");
    expect(conf).toContain("nats-leaf://127.0.0.1:19001");
    expect(conf).toContain("tls://127.0.0.1:19001");
    expect(conf).toContain("wss://127.0.0.1:19001");
    expect(conf).toContain("nats-route://127.0.0.1:19001");
  });

  test("moves every listener to a random loopback port", () => {
    const { conf } = renderBootTestConfig(SNAPSHOT, OPTS);
    expect(conf).not.toContain("4222");
    expect(conf).not.toContain("6222");
    expect(conf).not.toContain(":7422");
    expect(conf).not.toContain("8080");
    expect(conf).not.toContain("0.0.0.0");
    expect(conf).toContain(`listen: "127.0.0.1:-1"`);
    expect(conf).toContain("port: -1");
    expect(conf).toContain(`host: "127.0.0.1"`);
  });

  test("replaces the monitor with the throwaway one and drops pid/log files", () => {
    const { conf } = renderBootTestConfig(SNAPSHOT, OPTS);
    expect(conf).not.toContain("8222");
    expect(conf).not.toContain("pid_file");
    expect(conf).not.toContain("log_file");
    expect(conf).toContain(`http: "127.0.0.1:18123"`);
    expect(conf.match(/^\s*http\s*:/gm)?.length).toBe(1);
  });

  test("store + resolver dirs go to the scratch dir; no -sd when store_dir was rewritten", () => {
    const { conf, args } = renderBootTestConfig(SNAPSHOT, OPTS);
    expect(conf).not.toContain("/data/nats");
    expect(conf).not.toContain("/data/jwt");
    expect(conf).toContain(`store_dir: "/scratch/bt/store"`);
    expect(conf).toContain(`dir: "/scratch/bt/resolver"`);
    // jetstream domain + server_name are left alone
    expect(conf).toContain(`domain: "work-alice"`);
    expect(args).toEqual([]);
  });

  test("`jetstream: enabled` with no store_dir ⇒ -sd <scratch>/store (never the live default store)", () => {
    const { args } = renderBootTestConfig(`listen: 4222\njetstream: enabled\n`, OPTS);
    expect(args).toEqual(["-sd", "/scratch/bt/store"]);
  });

  test("a URL resolver's http:// scheme is not mistaken for an `http:` monitor key", () => {
    const { conf } = renderBootTestConfig(
      `listen: 4222\nresolver: URL(http://127.0.0.1:9090/jwt/v1/accounts/)\n`,
      OPTS,
    );
    expect(conf).toContain("URL(http://127.0.0.1:9090/jwt/v1/accounts/)");
  });
});
