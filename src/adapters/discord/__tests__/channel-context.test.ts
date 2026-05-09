import { test, expect, describe } from "bun:test";
import { resolveChannelContext, resolveGroveChannel } from "../channel-context";

const repos = [
  "the-metafactory/grove",
  "the-metafactory/meta-factory",
  "the-metafactory/arc",
];

describe("resolveChannelContext", () => {
  test("channel name matches repo short name", () => {
    const ctx = resolveChannelContext("grove", null, repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.repoShort).toBe("grove");
    expect(ctx.entityType).toBeNull();
    expect(ctx.entityRef).toBeNull();
  });

  test("channel name matches meta-factory", () => {
    const ctx = resolveChannelContext("meta-factory", null, repos);
    expect(ctx.repo).toBe("the-metafactory/meta-factory");
    expect(ctx.repoShort).toBe("meta-factory");
  });

  test("unrecognized channel returns null", () => {
    const ctx = resolveChannelContext("random-channel", null, repos);
    expect(ctx.repo).toBeNull();
    expect(ctx.entityType).toBeNull();
  });

  test("thread grove/issue/43 resolves to issue #43", () => {
    const ctx = resolveChannelContext("grove", "grove/issue/43", repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.entityType).toBe("issue");
    expect(ctx.entityRef).toBe("43");
  });

  test("thread grove/pr/45 resolves to PR #45", () => {
    const ctx = resolveChannelContext("grove", "grove/pr/45", repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.entityType).toBe("pr");
    expect(ctx.entityRef).toBe("45");
  });

  test("thread grove/g-204 resolves to feature g-204", () => {
    const ctx = resolveChannelContext("grove", "grove/g-204", repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.entityType).toBe("feature");
    expect(ctx.entityRef).toBe("g-204");
  });

  test("thread grove/f-007 resolves to feature f-007", () => {
    const ctx = resolveChannelContext("grove", "grove/f-007", repos);
    expect(ctx.entityType).toBe("feature");
    expect(ctx.entityRef).toBe("f-007");
  });

  test("thread grove/dd-49 resolves to feature dd-49", () => {
    const ctx = resolveChannelContext("grove", "grove/dd-49", repos);
    expect(ctx.entityType).toBe("feature");
    expect(ctx.entityRef).toBe("dd-49");
  });

  test("thread grove/i-400 resolves to feature i-400", () => {
    const ctx = resolveChannelContext("grove", "grove/i-400", repos);
    expect(ctx.entityType).toBe("feature");
    expect(ctx.entityRef).toBe("i-400");
  });

  test("free-form thread under repo returns repo only", () => {
    const ctx = resolveChannelContext("grove", "grove/hotfix-relay", repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.entityType).toBeNull();
    expect(ctx.entityRef).toBeNull();
  });

  test("thread not prefixed with repo name returns repo only", () => {
    const ctx = resolveChannelContext("grove", "some-unrelated-thread", repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.entityType).toBeNull();
  });

  test("most specific resolution wins", () => {
    // Issue > feature > repo
    const issue = resolveChannelContext("grove", "grove/issue/43", repos);
    const feature = resolveChannelContext("grove", "grove/g-204", repos);
    const repo = resolveChannelContext("grove", null, repos);

    expect(issue.entityType).toBe("issue");
    expect(feature.entityType).toBe("feature");
    expect(repo.entityType).toBeNull();
  });
});

describe("resolveGroveChannel", () => {
  test("grove channel matching repo name resolves", () => {
    const ctx = resolveGroveChannel("grove", repos);
    expect(ctx.repo).toBe("the-metafactory/grove");
    expect(ctx.repoShort).toBe("grove");
  });

  test("non-matching channel returns null", () => {
    const ctx = resolveGroveChannel("andreas", repos);
    expect(ctx.repo).toBeNull();
  });
});
