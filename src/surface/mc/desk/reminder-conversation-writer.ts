import type { CreateRequest, OwnerWriter } from "../../../conversations/types";
import { deskConversationWriter, instant, type DeskWriterDeps } from "./desk-conversation-writer";

function reminderFields(request: CreateRequest): { text: string; due: string } | string {
  const due = instant("due time", request.fields.due);
  if (typeof due === "string") return due;
  return { text: request.fields.title ?? "", due: new Date(due).toISOString() };
}

export const reminderWriter = (deps: DeskWriterDeps): OwnerWriter => deskConversationWriter({
  kind: "reminder", objects: "Reminders", noun: "reminders", destinationFlag: "--list", destinationField: "list", defaultDestination: "the default list", fields: reminderFields,
}, deps);
