// glossary-ignore: host, run, data
/** One mail as a Mail source listed it. A native `SourceReading` mail entry satisfies this shape. */
export interface MailSourceItem {
  readonly id: string;
  readonly account?: string;
  readonly from: { readonly name?: string; readonly address: string };
  readonly subject: string;
  readonly receivedAt: string;
  readonly unread: boolean;
  readonly firstParagraph?: string;
}

/** One Mail source's last listing, as the host's source cache holds it; `error` is set when that run failed. */
export interface MailSourceListing {
  readonly id: string;
  readonly readAt: number;
  readonly error: string | null;
  readonly mail: readonly MailSourceItem[];
}

/** The host's binding of one adapter connection to one Mail source and one account (cortex#3294 Q7). */
export interface MailConnectionBinding {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly sourceId: string;
  readonly account: string;
  readonly dataPolicy?: "local" | "cloud";
}

/** What the host supplies the loader so out-of-tree adapters can read listed mail. */
export interface MailReadSource {
  connections(): readonly MailConnectionBinding[];
  listings(): readonly MailSourceListing[];
}
