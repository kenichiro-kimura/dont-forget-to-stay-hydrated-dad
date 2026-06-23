import { DrinkEvent } from "../domain/DrinkEvent";

export enum DrinkStatus {
    Healthy,
    Alerting,
    RefillGrace
}

export class DrinkStatusJudge {
    private refillGraceSec : number;

    constructor(refillGraceSec: number) {
        this.refillGraceSec = refillGraceSec;
    }

    judge(events: DrinkEvent[]): DrinkStatus {
        const drinkEvents = events.filter((e) => e.type === "drink");
        const refillEvents = events.filter((e) => e.type === "refill");

        const latestDrinkAt = Math.max(...drinkEvents.map((e) => e.after.timestamp), 0);
        const latestRefillAt = Math.max(...refillEvents.map((e) => e.after.timestamp), 0);

        const hasDrinkAfterLatestRefill = latestDrinkAt > latestRefillAt;

        const now = Date.now();

        const hasDrink = hasDrinkAfterLatestRefill || (latestDrinkAt > 0 && latestRefillAt === 0);

        if (hasDrink) {
            return DrinkStatus.Healthy;
        } else if (latestRefillAt > 0 && now - latestRefillAt < this.refillGraceSec * 1000) {
            return DrinkStatus.RefillGrace;
        } else {
            return DrinkStatus.Alerting;
        }
    }
}