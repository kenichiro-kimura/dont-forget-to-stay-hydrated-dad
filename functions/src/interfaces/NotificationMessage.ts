export type NotificationLevel = "ok" | "alert";

export interface NotificationMessage {
  level: NotificationLevel;
  content: string;
  title: string;
  description: string;
  imageUrl?: string;
  details?: Record<string, unknown>;
}