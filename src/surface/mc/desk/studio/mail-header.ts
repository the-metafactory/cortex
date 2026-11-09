const HEADER = /^Mail from .*?, received [^“]*?: (?=“)/;
const OPEN_IN_MAIL = / Open in Mail: <[^>]*>$/;

/** The sender and receipt header a mail capture's question starts with. */
export const mailHeader = (sender: string, day: string): string => `Mail from ${sender}, received ${day}: `;

/** The link a mail capture's question ends with. */
export const openInMail = (target: string): string => ` Open in Mail: <${target}>`;

/** A mail capture's question with its header and link removed, so only the subject and summary remain. */
export const withoutMailFrame = (text: string): string => text.replace(HEADER, "").replace(OPEN_IN_MAIL, "");
