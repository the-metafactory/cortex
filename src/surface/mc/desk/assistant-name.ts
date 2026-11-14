import { DEFAULT_ASSISTANT_NAME } from "../../../common/types/assistant-name";

export const assistantNameOf = (options: { assistantName?: string } | undefined): string => options?.assistantName ?? DEFAULT_ASSISTANT_NAME;
