/**
 * Grove Mission Control v2 — Stream-json message framing.
 *
 * Formats operator input as stream-json messages for CC stdin.
 * Based on Maestro's streamJsonBuilder.ts pattern.
 *
 * Two overloads:
 *  - `buildStreamJsonMessage(text: string)` — legacy text-only shape,
 *    `content: "string"`. Kept unchanged for backward compatibility with
 *    the F-10 code path in `api/handlers.ts:handleSendInput` which passes
 *    a string, and for any downstream telemetry that expects that wire
 *    shape.
 *  - `buildStreamJsonMessage(blocks: StreamJsonContentBlock[])` — rich
 *    content array (text + image blocks), `content: [...]`. Used by the
 *    image-input path per `docs/design-mc-image-input.md` Decision 2.
 *
 * The framer is a dumb formatter — it does not validate media_type,
 * image size, or block shape. Callers enforce those bounds (see
 * `api/handlers.ts:handleSendInput`).
 */

/** Content-block discriminated union carried in the rich-overload content array. */
export type StreamJsonContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    };

export function buildStreamJsonMessage(
  input: string | StreamJsonContentBlock[]
): string {
  const msg = JSON.stringify({ type: "user_message", content: input });
  return msg + "\n";
}
