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

type DrinkEvent = {
  type: "drink" | "refill" | "no_change";
  mode: "pickup_return" | "adjacent";
  before: SensorPoint;
  after: SensorPoint;
  pickup?: SensorPoint;
  delta: number; // after.value - before.value
};

const cosmosClient = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || "");

export async function timerTrigger(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  const durationSec = parseInt(process.env.duration || "3600", 10);
  const drinkThreshold = parseInt(process.env.threshold || "5000", 10);
  const pickupDropThreshold = parseInt(process.env.pickupDropThreshold || "30000", 10);
  const returnLookahead = parseInt(process.env.returnLookahead || "5", 10);
  const minPoints = parseInt(process.env.minPoints || "3", 10);

  const points = await getSensorData(durationSec, context);

  if (points.length < minPoints) {
    context.log("Not enough sensor data.", { count: points.length });
    return;
  }

  const events = detectDrinkEvents(
    points,
    pickupDropThreshold,
    drinkThreshold,
    returnLookahead,
    context
  );

  const hasDrink = events.some((e) => e.type === "drink");

  context.log("Drink judgement", {
    points: points.length,
    events: events.length,
    hasDrink,
    events,
  });

  if (hasDrink) {
    context.log("OK: drink event detected.");
    return;
  }

  await sendAlert({
    durationSec,
    drinkThreshold,
    pickupDropThreshold,
    points: points.length,
    events: events.length,
  });
}

app.timer("timerTrigger", {
  schedule: "*/10 * * * * *",
  handler: timerTrigger,
});

async function getSensorData(
  durationSec: number,
  context: InvocationContext
): Promise<SensorPoint[]> {
  const database = cosmosClient.database(process.env.COSMOS_DB_NAME || "");
  const container = database.container(process.env.COSMOS_DB_CONTAINER_NAME || "");

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

async function sendAlert(details: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || "";

  if (!webhookUrl) {
    console.log("DISCORD_WEBHOOK_URL is not set.");
    return;
  }

  const message = {
    content:
      "💧 パパ、ちゃんと水分とってね\n" +
      "しばらく水筒の重さが減っていないみたいです。",
    embeds: [
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