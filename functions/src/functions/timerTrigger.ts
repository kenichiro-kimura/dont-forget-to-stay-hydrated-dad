import { app, InvocationContext, Timer } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { DrinkDetector } from "../domain/DrinkDetector";
import { INotifiler } from "../interfaces/INotifiler";
import { DiscordNotifier } from "../infrastructure/discord/DiscordNotifier";
import { IControlRepository } from "../interfaces/IControlRepository";
import { CosmosControlRepository } from "../infrastructure/cosmos/CosmosControlRepository";
import { ISensorRepository } from "../interfaces/ISensorRepository";
import { CosmosSensorRepository } from "../infrastructure/cosmos/CosmosSensorRepository";
import { DrinkMonitorService, DrinkMonitorConfig } from "../application/DrinkMonitorService";

const cosmosClient = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || "");
const database = cosmosClient.database(process.env.COSMOS_DB_NAME || "");
const container = database.container(process.env.COSMOS_DB_CONTAINER_NAME || "");
const webhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
const durationSec = parseInt(process.env.duration || "3600", 10);
const drinkThreshold = parseInt(process.env.threshold || "5000", 10);
const pickupDropThreshold = parseInt(process.env.pickupDropThreshold || "30000", 10);
const returnLookahead = parseInt(process.env.returnLookahead || "5", 10);
const minPoints = parseInt(process.env.minPoints || "3", 10);
const cooldownSeconds = parseInt(process.env.ALERT_COOLDOWN_SECONDS || "60", 10);
const maxAdjacentGapSec = parseInt(process.env.maxAdjacentGapSec || "120", 10);
const refillGraceSec = parseInt(process.env.refillGraceSec || "3600", 10);
const okImageUrl = process.env.OK_IMAGE_URL || "";
const ngImageUrl = process.env.NG_IMAGE_URL || "";
const drinkDetector = new DrinkDetector(maxAdjacentGapSec);
const drinkMonitorConfig: DrinkMonitorConfig = {
  durationSec,
  drinkThreshold,
  pickupDropThreshold,
  returnLookahead,
  minPoints,
  cooldownSeconds,
  refillGraceSec,
  okImageUrl,
  ngImageUrl
};

const notifier: INotifiler = new DiscordNotifier(webhookUrl);
const controlRepository: IControlRepository = new CosmosControlRepository(cosmosClient, process.env.COSMOS_DB_NAME || "", process.env.COSMOS_DB_CONTAINER_NAME || "");
const sensorRepository: ISensorRepository = new CosmosSensorRepository(cosmosClient, process.env.COSMOS_DB_NAME || "", process.env.COSMOS_DB_CONTAINER_NAME || "");
const drinkMonitorService = new DrinkMonitorService(sensorRepository, controlRepository, notifier, drinkDetector, drinkMonitorConfig);

export async function timerTrigger(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  drinkMonitorService.execute().catch((error) => {
    context.error("Error in DrinkMonitorService execution", error);
  });
} 

app.timer("timerTrigger", {
  schedule: "0 * * * * *",
  handler: timerTrigger,
});
