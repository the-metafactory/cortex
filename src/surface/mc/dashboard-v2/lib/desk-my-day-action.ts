import type { MyDayView } from "../../desk/my-day";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { postJson } from "./api";

export async function submitMyDay(date: string, command: MyDayCommand, requestId: string = crypto.randomUUID()): Promise<{ view: MyDayView; undo?: string; notice?: string; outlineId?: string; location?: string }> {
  return postJson("/api/desk/my-day", { date, command, requestId });
}
