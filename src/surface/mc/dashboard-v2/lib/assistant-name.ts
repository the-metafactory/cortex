import { createContext, useContext } from "react";
import { DEFAULT_ASSISTANT_NAME } from "../../../../common/types/assistant-name";

export const AssistantNameContext = createContext<string>(DEFAULT_ASSISTANT_NAME);

export const useAssistantName = (): string => useContext(AssistantNameContext);
