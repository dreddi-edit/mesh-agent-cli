export type ChatopsPlatform = "slack" | "discord";

export interface ChatopsMessage {
  platform: ChatopsPlatform;
  channel: string;
  user: string;
  text: string;
}

export interface ChatopsInvestigationStatus {
  threadId: string;
  status: "investigating" | "ready_for_approval" | "approved";
  updates: string[];
}
