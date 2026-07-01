import { Control, IControlRepository } from "../../interfaces/IControlRepository";
import { CosmosClient } from "@azure/cosmos";

export class CosmosControlRepository implements IControlRepository {
    private container: any;
    constructor(cosmosClient: CosmosClient, databaseName: string, containerName: string) {
        const database = cosmosClient.database(databaseName);
        this.container = database.container(containerName);
    }

    async get(): Promise<Control | null> {
        try {
            const { resource } =
                await this.container
                    .item("control", "control")
                    .read();

            const control: Control = {
                lastStatus: resource?.lastStatus || "",
                lastAlertAt: resource?.lastAlertAt || 0,
            };
            return control;
        } catch {
            return null;
        }
    }

    async update(control: Control): Promise<void> {
        const doc = {
            id: "control",
            partitionKey: "control",
            lastAlertAt: control.lastAlertAt,
            lastStatus: control.lastStatus
        };

        await this.container.items.upsert(doc);
    }
}
