import { SensorPoint } from "./SensorPoint";

export type DrinkEvent = {
  type: "drink" | "refill" | "no_change";
  mode: "pickup_return" | "adjacent";
  before: SensorPoint;
  after: SensorPoint;
  pickup?: SensorPoint;
  delta: number; // after.value - before.value
};