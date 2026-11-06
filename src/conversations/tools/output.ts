const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|sk-[A-Za-z0-9]{20,})\b|Bearer\s+[\w.~+/=-]{12,}/g;

export const redactToolText = (text: string): string => text.replace(SECRET, "[redacted]");
