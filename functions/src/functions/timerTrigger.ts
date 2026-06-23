import 'reflect-metadata';
import { container as diContainer } from 'tsyringe';
import { app, InvocationContext, Timer } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { SensorPoint } from "../domain/SensorPoint";
import { DrinkEvent } from "../domain/DrinkEvent";
import { DrinkDetector } from "../domain/DrinkDetector";
import { INotifiler } from "../interfaces/INotifiler";
import { DiscordNotifier } from "../infrastructure/discord/DiscordNotifier";
import { Control, IControlRepository } from "../interfaces/IControlRepository";
import { CosmosControlRepository } from "../infrastructure/cosmos/CosmosControlRepository";

type SensorItem = {
  id: string;
  _ts: number;
  Body?: {
    median?: number;
  };
};

enum AlertStatus {
   Healthy = "Healthy",
   Alerting = "Alerting"
}

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

diContainer.registerInstance<INotifiler>("INotifiler", new DiscordNotifier(webhookUrl) );
diContainer.registerInstance<IControlRepository>("IControlRepository", new CosmosControlRepository(cosmosClient, process.env.COSMOS_DB_NAME || "", process.env.COSMOS_DB_CONTAINER_NAME || ""));

const notifier: INotifiler = diContainer.resolve("INotifiler");
const controlRepository: IControlRepository = diContainer.resolve("IControlRepository");

export async function timerTrigger(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {

  const points = await getSensorData(durationSec, context);

  if (points.length < minPoints) {
    context.log("Not enough sensor data.", { count: points.length });
    context.log(points);
    return;
  }

  const events = drinkDetector.detect(
    points,
    pickupDropThreshold,
    drinkThreshold,
    returnLookahead
  );

  const drinkEvents = events.filter((e) => e.type === "drink");
  const refillEvents = events.filter((e) => e.type === "refill");

  const latestDrinkAt = Math.max(...drinkEvents.map((e) => e.after.timestamp), 0);
  const latestRefillAt = Math.max(...refillEvents.map((e) => e.after.timestamp), 0);

  const hasDrinkAfterLatestRefill = latestDrinkAt > latestRefillAt;

  const now = Date.now();

  const hasDrink = hasDrinkAfterLatestRefill || (latestDrinkAt > 0 && latestRefillAt === 0);

  context.log("Drink judgement", {
    points: points,
    events: JSON.stringify(events),
    hasDrink
  });

  const control = await controlRepository.get();
  if (hasDrink) {
    context.log("Healthy: drink event detected.");

    if (control?.lastStatus !== AlertStatus.Healthy || (await canSendAlert())) {
      await notifier.send({
        level: "ok",
        content: "水筒の重さが減っています。",
        title: "娘ちゃんからひとこと",
        description: "パパ、その調子で水分とってね！",
        imageUrl: okImageUrl,
        details: {
          drinkThreshold,
          pickupDropThreshold,
          points: points.length,
          events: events.length
        }
      });
      await controlRepository.update({
        lastStatus: AlertStatus.Healthy,
        lastAlertAt: new Date().toISOString()
      });
    } else {
      context.log(
        "Healthy alert skipped because last status was Healthy and cooldown is active."
      );
    }
  } else if (latestRefillAt > 0 && now - latestRefillAt < refillGraceSec * 1000) {
    context.log("Refill detected recently. Skip alert during grace period.", {
      latestRefillAt,
      refillGraceSec,
    });
    return;      
  } else {
    if (control?.lastStatus !== AlertStatus.Alerting || (await canSendAlert())) {
      await notifier.send({
        level: "alert",
        content: "しばらく水筒の重さが減っていないようです。",
        title: "娘ちゃんからひとこと",
        description: "パパ、ちゃんと水分とってね！",
        imageUrl: ngImageUrl,
        details: {
          drinkThreshold,
          pickupDropThreshold,
          points: points.length,
          events: events.length
        }
      });
      await controlRepository.update({
        lastStatus: AlertStatus.Alerting,
        lastAlertAt: new Date().toISOString()
      });
    } else {
      context.log(
        "Alert skipped because cooldown is active."
      );
    } 
  }
} 

app.timer("timerTrigger", {
  schedule: "0 * * * * *",
  handler: timerTrigger,
});

async function getSensorData(
  durationSec: number,
  context: InvocationContext
): Promise<SensorPoint[]> {

  //const fromUnixSec = Math.floor(Date.now() / 1000) - durationSec;
  const fromUnixSec = 1782117600;
  context.log(`Calculating fromUnixSec with current time: ${Math.floor(Date.now() / 1000)}, durationSec: ${durationSec}`);

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

  const { resources } = await container.items
    .query<SensorItem>(querySpec)
    .fetchAll();

  const points = resources
    .filter((item) => typeof item.Body?.median === "number")
    .map((item) => ({
      timestamp: item._ts * 1000,
      value: item.Body!.median!,
    }));

  context.log(`Fetched ${points.length} sensor points.`);
  return points;
}

async function canSendAlert(): Promise<boolean> {
    const control = await controlRepository.get();
    const now = Date.now();

    const lastAlert =
        control?.lastAlertAt
            ? new Date(control.lastAlertAt).getTime()
            : 0;

    return (
        now - lastAlert >
        cooldownSeconds * 1000
    );
}
