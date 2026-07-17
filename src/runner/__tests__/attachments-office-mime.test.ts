/**
 * Office document attachments must pass the inbound MIME allowlist.
 *
 * The defect this closes: cortex's inbound-attachment allowlist
 * (`ALLOWED_MIME_TYPES`) carried images/text/pdf/json/xml/zip but NO Office
 * types, so a .docx dropped in chat was fetched then discarded — observed on a
 * live daemon as:
 *   discord-attachments: errors: …docx: Blocked file type:
 *   application/vnd.openxmlformats-officedocument.wordprocessingml.document
 *
 * The fix adds the common Office MIME types (OOXML, legacy binary, ODF) to the
 * allowlist and a container-level magic-byte signature for each: OOXML/ODF are
 * ZIP containers (PK\x03\x04); legacy .doc/.xls/.ppt are OLE2 compound files
 * (D0 CF 11 E0). The signature verifies the container, not the specific
 * application — magic bytes were only ever an anti-polyglot container guard.
 */

import { describe, test, expect } from "bun:test";

import { ALLOWED_MIME_TYPES } from "../attachment-types";
import { validateMagicBytes } from "../attachments";

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const OLE2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]); // OLE compound file
const NOT_A_CONTAINER = new Uint8Array([0xff, 0xd8, 0xff, 0x00]); // JPEG-ish

const OOXML = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
];
const ODF = [
  "application/vnd.oasis.opendocument.text", // .odt
  "application/vnd.oasis.opendocument.spreadsheet", // .ods
  "application/vnd.oasis.opendocument.presentation", // .odp
];
const LEGACY = [
  "application/msword", // .doc
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-powerpoint", // .ppt
];

describe("Office attachments pass the inbound MIME allowlist", () => {
  test("the .docx type that was blocked on the live daemon is now allowed", () => {
    // The exact MIME from the observed "Blocked file type" log line.
    expect(
      ALLOWED_MIME_TYPES.has(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
  });

  test("every OOXML, ODF, and legacy Office MIME is on the allowlist", () => {
    for (const mime of [...OOXML, ...ODF, ...LEGACY]) {
      expect(ALLOWED_MIME_TYPES.has(mime)).toBe(true);
    }
  });

  test("an unlisted type is still blocked", () => {
    expect(ALLOWED_MIME_TYPES.has("application/x-msdownload")).toBe(false);
    expect(ALLOWED_MIME_TYPES.has("application/octet-stream")).toBe(false);
  });
});

describe("Office attachments pass container magic-byte validation", () => {
  test("OOXML/ODF declared types validate against a ZIP container", () => {
    for (const mime of [...OOXML, ...ODF]) {
      expect(validateMagicBytes(ZIP, mime)).toBe(true);
    }
  });

  test("legacy Office declared types validate against an OLE2 container", () => {
    for (const mime of LEGACY) {
      expect(validateMagicBytes(OLE2, mime)).toBe(true);
    }
  });

  // Anti-polyglot negatives pin EVERY signature entry. A positive assertion
  // (right bytes → true) stays green even if a MAGIC_BYTES entry is deleted,
  // because validateMagicBytes falls back to true when no signature exists for
  // the MIME. A negative assertion (wrong bytes → false) can ONLY pass while
  // the entry is present, so deleting any one of the 9 entries turns a test red.
  const MZ_EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ — not PK, not OLE2

  test("every OOXML/ODF type rejects a non-ZIP header (pins each PK signature)", () => {
    for (const mime of [...OOXML, ...ODF]) {
      // Both headers are non-PK — either would slip through the no-signature
      // fallback if this MIME's entry were deleted.
      expect(validateMagicBytes(NOT_A_CONTAINER, mime)).toBe(false);
      expect(validateMagicBytes(MZ_EXE, mime)).toBe(false);
    }
  });

  test("every legacy Office type rejects a non-OLE2 header (pins each D0CF signature)", () => {
    for (const mime of LEGACY) {
      // ZIP bytes are the wrong container for OLE2 types — rejection is only
      // possible while the legacy signature entry exists.
      expect(validateMagicBytes(NOT_A_CONTAINER, mime)).toBe(false);
      expect(validateMagicBytes(ZIP, mime)).toBe(false);
    }
  });
});
