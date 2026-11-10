import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { getJson, postJson } from "./api";

export async function submitMyDay(date: string, command: MyDayCommand, requestId: string = crypto.randomUUID()): Promise<{ view: MyDayView; undo?: string; notice?: string; outlineId?: string; location?: string }> {
  return postJson("/api/desk/my-day", { date, command, requestId });
}

export function refreshMyDay(signal?: AbortSignal): Promise<MyDayView> {
  return getJson("/api/desk/my-day?observation=refresh", signal ? { signal } : undefined);
}
