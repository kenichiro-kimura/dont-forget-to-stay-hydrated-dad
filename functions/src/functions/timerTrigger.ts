import { app, InvocationContext, Timer } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

type SensorItem = {
  id: string;
  _ts: number;
  Body?: {
    median?: number;
  };
};

type SensorPoint = {
  timestamp: number;
  value: number;
};

enum AlertStatus {
   OK = "OK",
   ALERT_SENT = "ALERT_SENT"
}

type DrinkEvent = {
  type: "drink" | "refill" | "no_change";
  mode: "pickup_return" | "adjacent";
  before: SensorPoint;
  after: SensorPoint;
  pickup?: SensorPoint;
  delta: number; // after.value - before.value
};

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

  const events = detectDrinkEvents(
    points,
    pickupDropThreshold,
    drinkThreshold,
    returnLookahead,
    context
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

  if (hasDrink) {
    context.log("OK: drink event detected.");
    const control = await getControl();

    if (control?.lastStatus !== AlertStatus.OK || (await canSendAlert())) {
      await sendAlert(
        "水筒の重さが減っています。",
        {
          title: "娘ちゃんからひとこと",
          description: "パパ、その調子で水分とってね！",
          color: 0x3498db,
          image: {
            url: okImageUrl,
          },
        },
        {
        durationSec,
        drinkThreshold,
        pickupDropThreshold,
        points: points.length,
        events: events.length,
      });
      await updateLastAlert(AlertStatus.OK);
    } else {
      context.log(
        "OK alert skipped because last status was OK and cooldown is active."
      );
    }
  } else if (latestRefillAt > 0 && now - latestRefillAt < refillGraceSec * 1000) {
    context.log("Refill detected recently. Skip alert during grace period.", {
      latestRefillAt,
      refillGraceSec,
    });
    return;      
  } else {
    if (await canSendAlert()) {
      await sendAlert(
        "しばらく水筒の重さが減っていないようです。",
        {
          title: "娘ちゃんからひとこと",
          description: "パパ、ちゃんと水分とってね！",
          color: 0x3498db,
          image: {
            url: ngImageUrl,
          },
        },
        {
        durationSec,
        drinkThreshold,
        pickupDropThreshold,
        points: points.length,
        events: events.length,
      });
      await updateLastAlert(AlertStatus.ALERT_SENT);
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

  const fromUnixSec = Math.floor(Date.now() / 1000) - durationSec;
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

function secondsBetween(a: SensorPoint, b: SensorPoint): number {
  return Math.abs(b.timestamp - a.timestamp) / 1000;
}

function detectDrinkEvents(
  points: SensorPoint[],
  pickupDropThreshold: number,
  drinkThreshold: number,
  returnLookahead: number,
  context: InvocationContext
): DrinkEvent[] {
  const events: DrinkEvent[] = [];
  const consumedIndexes = new Set<number>();

  // 1. pickup -> return を優先して見る
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1];
    const pickup = points[i];
    const drop = before.value - pickup.value;

    if (drop < pickupDropThreshold) {
      continue;
    }

    const returnResult = findReturnPoint(
      points,
      i + 1,
      before.value,
      pickupDropThreshold,
      returnLookahead
    );

    if (!returnResult) {
      context.log("Pickup detected, but return point was not found.", {
        before,
        pickup,
        drop,
      });
      continue;
    }

    const { point: after, index: afterIndex } = returnResult;
    const delta = after.value - before.value;

    const event = classifyEvent({
      mode: "pickup_return",
      before,
      pickup,
      after,
      delta,
      drinkThreshold,
    });

    events.push(event);

    // pickup周辺を隣接判定で二重検出しないようにする
    consumedIndexes.add(i - 1);
    consumedIndexes.add(i);
    consumedIndexes.add(afterIndex);

    context.log("Detected pickup-return event", event);
  }

  // 2. pickup が取れていないケース用に、隣接値の減少/増加も見る
  for (let i = 1; i < points.length; i++) {
    if (consumedIndexes.has(i - 1) || consumedIndexes.has(i)) {
      continue;
    }

    const before = points[i - 1];
    const after = points[i];

    if (secondsBetween(before, after) > maxAdjacentGapSec) {
      continue;
    }    

    const delta = after.value - before.value;

    if (Math.abs(delta) < drinkThreshold) {
      continue;
    }

    const event = classifyEvent({
      mode: "adjacent",
      before,
      after,
      delta,
      drinkThreshold,
    });

    events.push(event);
    context.log("Detected adjacent event", event);
  }

  return events;
}

function findReturnPoint(
  points: SensorPoint[],
  startIndex: number,
  beforeValue: number,
  pickupDropThreshold: number,
  returnLookahead: number
): { point: SensorPoint; index: number } | null {
  const endIndex = Math.min(points.length, startIndex + returnLookahead);

  for (let i = startIndex; i < endIndex; i++) {
    const candidate = points[i];

    // まだ持ち上げ中の低い値は無視
    if (beforeValue - candidate.value >= pickupDropThreshold) {
      continue;
    }

    return {
      point: candidate,
      index: i,
    };
  }

  return null;
}

function classifyEvent(args: {
  mode: "pickup_return" | "adjacent";
  before: SensorPoint;
  after: SensorPoint;
  delta: number;
  drinkThreshold: number;
  pickup?: SensorPoint;
}): DrinkEvent {
  let type: DrinkEvent["type"] = "no_change";

  if (args.delta <= -args.drinkThreshold) {
    type = "drink";
  } else if (args.delta >= args.drinkThreshold) {
    type = "refill";
  }

  return {
    type,
    mode: args.mode,
    before: args.before,
    pickup: args.pickup,
    after: args.after,
    delta: args.delta,
  };
}

async function getControl() {
    try {
        const { resource } =
            await container
                .item("control", "control")
                .read();

        return resource;
    }
    catch {
        return null;
    }
}

async function updateLastAlert(status: AlertStatus) {
    const doc = {
        id: "control",
        partitionKey: "control",
        lastAlertAt: new Date().toISOString(),
        lastStatus: status
    };

    await container.items.upsert(doc);
}

async function canSendAlert(): Promise<boolean> {
    const control = await getControl();
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

async function sendAlert(content: string, imageContent: { title: string; description: string, color: number, image: { url: string }}, details: Record<string, unknown>): Promise<void> {
  if (!webhookUrl) {
    console.log("DISCORD_WEBHOOK_URL is not set.");
    return;
  }

  const message = {
    content: content,
    embeds: [
      imageContent,
      {
        title: "Judgement details",
        color: 0x3498db,
        fields: Object.entries(details).map(([name, value]) => ({
          name,
          value: String(value),
          inline: true,
        })),
      },
    ],
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}