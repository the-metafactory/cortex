# Desk Mail actions prototype

A throwaway browser prototype for [Desk adapters: decide Mail's full migration](https://github.com/the-metafactory/cortex/issues/3356). All data in it is made up.

Open `index.html` in a browser. The switch at the top sets how the provider answers the next click: normally, with the mail moved since, with the mail gone, with the account denied, or with no answer.

It shows what Mail adds to the My Day prototype:

- The host asks beside the pressed button on first use, with "Ja, ab jetzt mit einem Klick", "Nur dieses Mal" and "Abbrechen". Each grant names one mail connection and one action family.
- Warnings for actions with outside effects: a provider report, an invitation reply and unsubscribing. A report saved as a draft needs no grant.
- Removing a declined invitation is a separate action, offered after declining.
- A sweep shows its selection rule and message count before it runs, and needs its own grant.
- Every attempt gets a receipt. Undo refuses with a conflict when the mail has moved since, and a missing mail or a denied account is refused with nothing run. An unanswered call stays unclear until it is checked.

`index.html` is built from `mail-auth.de.js` by `build-mail.ts`, which ran in the Threva prototype tree, because it reuses that tree's styles. The principal approved the prototype as built on 2026-11-13.
