const LEGACY_ACTIONS: readonly [string, string][] = [
  ["ivy.hand", "assistant.hand"],
  ["ivy.approve", "assistant.approve"],
  ["ivy.discard", "assistant.discard"],
  ["ivy.retry", "assistant.retry"],
  ["ivy.edit", "assistant.edit"],
  ["mail.ivy", "mail.assistant"],
];

const renameKey = (table: string, column: string): string =>
  `UPDATE OR IGNORE ${table} SET ${column} = 'assistant:' || substr(${column}, 5) WHERE ${column} LIKE 'ivy:%'`;

/** Rewrites stored rows that carry the old hand-off ids, card keys and mail log action. Idempotent: a second run matches nothing. */
export const ASSISTANT_ROW_MIGRATIONS: string[] = [
  "UPDATE desk_mail_log SET action = 'assistant' WHERE action = 'ivy'",
  ...LEGACY_ACTIONS.flatMap(([from, to]) => [
    `UPDATE desk_done SET action = '${to}' WHERE action = '${from}'`,
    `UPDATE OR IGNORE desk_grants SET action = '${to}' WHERE action = '${from}'`,
  ]),
  renameKey("desk_done", "item_key"),
  renameKey("desk_links", "from_key"),
  renameKey("desk_links", "to_key"),
  renameKey("desk_interrupt_feedback", "item_key"),
];
