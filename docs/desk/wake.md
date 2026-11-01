# Enable a wake phrase

Build the dashboard from the Cortex checkout:

```sh
bun install --frozen-lockfile
bun run build:dashboard
```

Provision tokens with the matched BPE model. Python is a provisioning tool only; the running Desk does not need it.

```sh
python3 -m venv /tmp/cortex-wake-provision
/tmp/cortex-wake-provision/bin/pip install sentencepiece==0.2.2
/tmp/cortex-wake-provision/bin/python scripts/desk-wake/phrase.py 'Hey Ivy'
```

Copy the emitted `phrase`, `tokens`, and `tokenizerSha256` into `voice.wake` in `desk.yaml`. Keep the existing ElevenLabs settings and add:

```yaml
voice:
  input: elevenlabs
  wake:
    enabled: true
    agentName: Ivy
    phrase: HEY IVY
    tokens: [▁HE, Y, ▁I, V, Y]
    tokenizerSha256: c8a2a0129c4ab8e463164c142f82d25649661b122c8cd0b7aab5c9e80b90ad24
```

Restart Cortex, open Desk, and select **Enable wake**. Grant microphone permission. Say the phrase followed immediately by a command. Desk shows listening, recording, transcribing, and answering states. **Disable wake** stops capture. The setting makes the control available; it does not activate the microphone on page load.

Check the phrase with your own voice before relying on it. The qualification fixtures include a synthetic “Hey Ivy” miss, a negative-speech non-trigger, and a public-reference “early nightfall” trigger. These observations do not measure accuracy for your voice. The principal reported successful live prototype activations, including while minimized; production acceptance still needs a separate live check.

For automated browser checks, install Playwright's Chromium once, then run:

```sh
bunx playwright install chromium
bun scripts/desk-wake/probe-browser.ts
```

The probe uses generated audio, actual AudioWorklet and MediaRecorder nodes, and the existing server transcription adapter with a test provider. It does not request your microphone or claim a successful real-provider or human acceptance test.

To check an already configured loopback Desk against its actual providers, run:

```sh
bun scripts/desk-wake/probe-provider.ts http://127.0.0.1:8767/desk
```

This records the synthesized speech fixture through MediaRecorder, submits it once for transcription, and plays a fixed test sentence through the configured speech output. It does not request microphone access. It uses the providers already configured on that Desk.

See [Local wake detection](configuration.md#local-wake-detection) for settings and lifecycle limits.
