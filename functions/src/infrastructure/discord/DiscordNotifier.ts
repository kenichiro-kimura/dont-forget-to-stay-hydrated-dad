import { INotifiler } from "../../interfaces/INotifiler";
import { NotificationMessage } from "../../interfaces/NotificationMessage";

export class DiscordNotifier implements INotifiler {
    private readonly webhookUrl: string;
    constructor(webhookUrl: string) {
        if (!webhookUrl) {
            throw new Error("DISCORD_WEBHOOK_URL is not set.");
        }
        this.webhookUrl = webhookUrl;
    }

    async send(message: NotificationMessage): Promise<void> {
        const discordPayload = {
            content: message.content,
              embeds: [
                {
                    title: message.title,
                    description: message.description,
                    color: message.level === "ok" ? 0x3498db : 0xe74c3c,
                    image: message.imageUrl ? { url: message.imageUrl } : undefined,
                },
                {
                    title: "Judgement details",
                    color: 0x3498db,
                    fields: Object.entries(message.details ?? {}).map(([name, value]) => ({
                        name,
                        value: String(value),
                        inline: true,
                    })),
                },
            ],
        };

        await fetch(this.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(discordPayload),
        }); 
    }
}
