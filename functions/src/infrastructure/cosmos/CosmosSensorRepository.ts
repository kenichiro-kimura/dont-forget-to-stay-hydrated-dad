import { ISensorRepository } from "../../interfaces/ISensorRepository";
import { SensorPoint } from "../../domain/SensorPoint";
import { CosmosClient, Container } from "@azure/cosmos";

type SensorItem = {
  id: string;
  _ts: number;
  Body?: {
    median?: number;
  };
};

export class CosmosSensorRepository implements ISensorRepository {
    private container: Container;
    constructor(cosmosClient: CosmosClient, databaseName: string, containerName: string) {
        const database = cosmosClient.database(databaseName);
        this.container = database.container(containerName);
    }

    async getSensorData(durationSec: number): Promise<SensorPoint[]> {
        const fromUnixSec = Math.floor(Date.now() / 1000) - durationSec;

        const querySpec = {
            query: `
                SELECT c.id, c._ts, c.Body
                FROM c
                WHERE c._ts >= @fromUnixSec
                AND IS_DEFINED(c.Body.median)
                ORDER BY c._ts ASC
                `,
                parameters: [{ name: "@fromUnixSec", value: fromUnixSec }],
        };

        const { resources } = await this.container.items
            .query<SensorItem>(querySpec)
            .fetchAll();

        const points = resources
            .filter((item) => typeof item.Body?.median === "number")
            .map((item) => ({
                timestamp: item._ts * 1000,
                value: item.Body!.median!,
            }));

        return points;
    }
}