import { NotificationMessage } from "./NotificationMessage";

export interface INotifiler {
    send(message: NotificationMessage): Promise<void>;
}