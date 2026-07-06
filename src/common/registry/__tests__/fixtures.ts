/**
 * Shared test fixtures for the sealed-envelope suites (#1597). Clearly-FAKE
 * material only — structure-shaped, all-A payloads, never realistic keys.
 */

/** Clearly-FAKE `.creds` text (structure only, all-A payloads). */
export const FAKE_CREDS =
  "-----BEGIN NATS USER JWT-----\n" + "A".repeat(64) + "\n------END NATS USER JWT------\n\n" +
  "-----BEGIN USER NKEY SEED-----\nSUA" + "A".repeat(55) + "\n------END USER NKEY SEED------\n";
