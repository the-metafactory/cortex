/**
 * cortex#1792 (S6) — deliberately never imported: the duplicate-platform
 * gate refuses this bundle by manifest id BEFORE `import()` runs. If this
 * module is ever executed, the loader's ordering guarantee ("refused
 * bundles never run") is broken — fail loudly so a regression is obvious.
 */
throw new Error(
  "shadow-discord-bundle/index.ts must never be imported — the duplicate-platform gate should have refused it first",
);
