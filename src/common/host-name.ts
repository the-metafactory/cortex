/** A DNS host name: dot-separated labels and an alphabetic top-level label, lowercase. */
export const HOST_NAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
