const REPLY_PREFIX = /^(re|aw|antw|sv):/i;

export const replySubject = (subject: string): string => {
  const value = subject.trim();
  return REPLY_PREFIX.test(value) ? value : `Re: ${value}`;
};
