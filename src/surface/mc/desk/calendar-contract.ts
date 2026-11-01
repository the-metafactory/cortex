import { z } from "zod";

const instant = z.iso.datetime({ offset: true });
export const SourceCapabilitiesSchema = z.array(z.enum(["calendar", "attention"])).min(1).max(2)
  .refine(values => new Set(values).size === values.length, "capabilities must be unique");
export const EventAvailabilitySchema = z.object({
  status: z.enum(["busy", "free", "unknown"]),
  provenance: z.string().trim().min(1).max(200),
});
export const CalendarCoverageSchema = z.object({
  from: instant,
  to: instant,
  calendars: z.array(z.object({ id: z.string().trim().min(1).max(500), name: z.string().trim().min(1).max(200) })),
  status: z.enum(["complete", "partial"]),
  provenance: z.string().trim().min(1).max(200),
}).refine(value => Date.parse(value.to) > Date.parse(value.from), "coverage must end after it starts");
export type EventAvailability = z.infer<typeof EventAvailabilitySchema>;
export type CalendarCoverage = z.infer<typeof CalendarCoverageSchema>;
export type SourceCapabilities = z.infer<typeof SourceCapabilitiesSchema>;
