import { createHash } from "node:crypto";

const digest = (operationId: string): Buffer => createHash("sha256").update(operationId).digest();

export const studioRequestId = (operationId: string): string => `conv-${digest(operationId).toString("hex").slice(0, 56)}`;

export function operationUuid(operationId: string): string {
  const bytes = digest(operationId).subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
