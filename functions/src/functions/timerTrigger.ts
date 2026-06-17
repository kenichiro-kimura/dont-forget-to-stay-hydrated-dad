import { app, InvocationContext, Timer } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

type SensorItem = {
  id: string;
  _ts: number; // Cosmos DB unix seconds
  Body?: {
    median?: number;
    min?: number;
    max?: number;
    average?: number;
    range?: number;
    slope?: number;
    count?: number;
  };
};

type SensorPoint = {
  timestamp: number; // ms
  value: number;
  raw: SensorItem;
};

const cosmosClient = new CosmosClient(
  process.env.COSMOS_DB_CONNECTION_STRING || ""
);

export async function timerTrigger(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  const durationSec = parseInt(process.env.duration || "3600", 10);
  const threshold = parseInt(process.env.threshold || "5000", 10);

  // 水筒を持ち上げた時の大きな落ち込みを除外する閾値
  // 実測では「飲んだ」が約10000、「持ち上げ」はもっと大きいはずなので調整してね
  const pickupDropThreshold = parseInt(
    process.env.pickupDropThreshold || "30000",
    10
  );

  const minValidPoints = parseInt(process.env.minValidPoints || "3", 10);

  context.log("Timer function processed request.");
  context.log({
    durationSec,
    threshold,
    pickupDropThreshold,
    minValidPoints,
  });

  const data = await getSensorData(durationSec, context);

  if (data.length === 0) {
    context.log("No sensor data found.");
    return;
  }

  const filtered = removePickupPoints(data, pickupDropThreshold, context);

  if (filtered.length < minValidPoints) {
    context.log("Not enough valid points after filtering pickup points.", {
      originalCount: data.length,
      filteredCount: filtered.length,
    });
    return;
  }

  const values = filtered.map((d) => d.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue;

  const firstValue = filtered[0].value;
  const lastValue = filtered[filtered.length - 1].value;
  const valueChange = lastValue - firstValue;

  context.log("Judgement result", {
    originalCount: data.length,
    filteredCount: filtered.length,
    firstValue,
    lastValue,
    minValue,
    maxValue,
    valueRange,
    valueChange,
  });

  // 減った/増えたが閾値を超えていればOK
  // 増えた場合は補充や置き直しとしてOK扱い
  if (valueRange > threshold) {
    context.log("OK: value changed enough.");
    return;
  }

  context.log("NG: value did not change enough.");
  await sendAlert({
    durationSec,
    threshold,
    pickupDropThreshold,
    originalCount: data.length,
    filteredCount: filtered.length,
    firstValue,
    lastValue,
    minValue,
    maxValue,
    valueRange,
    valueChange,
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
  const container = database.container(
    process.env.COSMOS_DB_CONTAINER_NAME || ""
  );

  const fromUnixSec = Math.floor(Date.now() / 1000) - durationSec;

  const querySpec = {
    query: `
      SELECT c.id, c._ts, c.Body
      FROM c
      WHERE c._ts >= @fromUnixSec
        AND IS_DEFINED(c.Body.median)
      ORDER BY c._ts ASC
    `,
    parameters: [
      {
        name: "@fromUnixSec",
        value: fromUnixSec,
      },
    ],
  };

  const { resources } = await container.items
    .query<SensorItem>(querySpec)
    .fetchAll();

  const points = resources
    .filter((item) => typeof item.Body?.median === "number")
    .map((item) => ({
      timestamp: item._ts * 1000,
      value: item.Body!.median!,
      raw: item,
    }));

  context.log(`Fetched ${points.length} sensor points.`);

  return points;
}

function removePickupPoints(
  points: SensorPoint[],
  pickupDropThreshold: number,
  context: InvocationContext
): SensorPoint[] {
  if (points.length === 0) {
    return [];
  }

  const values = points.map((p) => p.value);

  // 水筒を持ち上げた値は大きく下がるので、
  // 全体の上位側中央値を「水筒が置かれている状態の基準値」とみなす。
  const baseline = upperHalfMedian(values);

  const filtered = points.filter((p) => {
    const dropFromBaseline = baseline - p.value;

    if (dropFromBaseline > pickupDropThreshold) {
      context.log("Removed pickup/dropout point", {
        timestamp: p.timestamp,
        value: p.value,
        baseline,
        dropFromBaseline,
      });
      return false;
    }

    return true;
  });

  return filtered;
}

function upperHalfMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const upperHalf = sorted.slice(Math.floor(sorted.length / 2));
  return median(upperHalf);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
  }

  return sorted[mid];
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
      "しばらく水筒の重さがあまり変わっていないみたいです。",
    embeds: [
      {
        title: "Sensor judgement details",
        color: 0x3498db,
        fields: Object.entries(details).map(([name, value]) => ({
          name,
          value: String(value),
          inline: true,
        })),
      },
    ],
  };

  const fetchFn =
    globalThis.fetch ?? (await import("node-fetch")).default;

  await fetchFn(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
}