/**
 * R26 P1 (cortex#1371) — tests for the admission KV bucket provisioning
 * (`provision.ts`): bucket naming, created/exists reporting, and the
 * NON-FATAL unavailable path that hands the gate its degraded posture.
 */

import { describe, expect, test } from "bun:test";
import type { ProvisionJsm, ProvisionKv } from "../../jetstream/types";
import { admissionBucketName, provisionAdmissionKv } from "../provision";

const silentLog = { info: () => {}, warn: () => {} };

function stubJsm(existingStreams: readonly string[]): ProvisionJsm {
  return {
    streams: {
       
      info: async (name: string) => {
        if (existingStreams.includes(name)) {
          return {} as Awaited<ReturnType<ProvisionJsm["streams"]["info"]>>;
        }
        const err = new Error("stream not found") as Error & {
          api_error: { err_code: number };
        };
        err.api_error = { err_code: 10059 };
        throw err;
      },
      add: async () => {
        throw new Error("unexpected streams.add in admission provisioning");
      },
    },
    consumers: {
      info: async () => {
        throw new Error("unused");
      },
      add: async () => {
        throw new Error("unused");
      },
      update: async () => {
        throw new Error("unused");
      },
      delete: async () => {
        throw new Error("unused");
      },
    },
  };
}

const stubKv: ProvisionKv = {
   
  get: async () => null,
   
  create: async () => 1,
   
  update: async () => 2,
};

describe("admissionBucketName", () => {
  test("builds the myelin spec §2 shape from subject segments", () => {
    expect(admissionBucketName("metafactory", "default")).toBe(
      "admission_metafactory_default",
    );
    expect(admissionBucketName("andreas", "work")).toBe("admission_andreas_work");
  });

  test("defensively maps non-bucket-safe characters to '-'", () => {
    expect(admissionBucketName("andreas", "an/odd.stack")).toBe(
      "admission_andreas_an-odd-stack",
    );
  });
});

describe("provisionAdmissionKv", () => {
  test("reports 'created' when the backing stream did not pre-exist", async () => {
    const result = await provisionAdmissionKv({
      jsm: stubJsm([]),
       
      openKv: async () => stubKv,
      bucket: "admission_metafactory_default",
      log: silentLog,
    });
    expect(result.outcome).toBe("created");
    expect(result.kv).toBe(stubKv);
  });

  test("reports 'exists' when the backing stream pre-exists (idempotent boot)", async () => {
    const result = await provisionAdmissionKv({
      jsm: stubJsm(["KV_admission_metafactory_default"]),
       
      openKv: async () => stubKv,
      bucket: "admission_metafactory_default",
      log: silentLog,
    });
    expect(result.outcome).toBe("exists");
    expect(result.kv).toBe(stubKv);
  });

  test("open failure is NON-FATAL: 'unavailable' + null kv (degraded posture), never a throw", async () => {
    const result = await provisionAdmissionKv({
      jsm: stubJsm([]),
      openKv: async () => {
        throw new Error("no jetstream");
      },
      bucket: "admission_metafactory_default",
      log: silentLog,
    });
    expect(result).toEqual({ outcome: "unavailable", kv: null });
  });

  test("disabled runtime (openKv → null, jsm null) resolves 'unavailable'", async () => {
    const result = await provisionAdmissionKv({
      jsm: null,
       
      openKv: async () => null,
      bucket: "admission_metafactory_default",
      log: silentLog,
    });
    expect(result).toEqual({ outcome: "unavailable", kv: null });
  });

  test("a non-404 peek failure still proceeds to the KV open (open decides)", async () => {
    const jsm = stubJsm([]);
    jsm.streams.info = async () => {
      throw new Error("auth timeout");
    };
    const result = await provisionAdmissionKv({
      jsm,
       
      openKv: async () => stubKv,
      bucket: "admission_metafactory_default",
      log: silentLog,
    });
    expect(result.outcome).toBe("exists");
    expect(result.kv).toBe(stubKv);
  });
});
