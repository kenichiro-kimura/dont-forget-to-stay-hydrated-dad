import { SensorPoint } from './SensorPoint';
import { DrinkEvent } from './DrinkEvent';

export class DrinkDetector {
    private readonly maxAdjacentGapSec: number;

    constructor(maxAdjacentGapSec: number) {
        this.maxAdjacentGapSec = maxAdjacentGapSec;
    }

    private secondsBetween(a: SensorPoint, b: SensorPoint): number {
        return Math.abs(b.timestamp - a.timestamp) / 1000;
    }

    private findReturnPoint(
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

    classifyEvent(args: {
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

    detect(
        points: SensorPoint[],
        pickupDropThreshold: number,
        drinkThreshold: number,
        returnLookahead: number
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

            const returnResult = this.findReturnPoint(
                points,
                i + 1,
                before.value,
                pickupDropThreshold,
                returnLookahead
            );

            if (!returnResult) {
                continue;
            }

            const { point: after, index: afterIndex } = returnResult;
            const delta = after.value - before.value;

            const event = this.classifyEvent({
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
        }
    
        // 2. pickup が取れていないケース用に、隣接値の減少/増加も見る
        for (let i = 1; i < points.length; i++) {
            if (consumedIndexes.has(i - 1) || consumedIndexes.has(i)) {
                continue;
            }

            const before = points[i - 1];
            const after = points[i];

            if (this.secondsBetween(before, after) > this.maxAdjacentGapSec) {
                continue;
            }    

            const delta = after.value - before.value;

            if (Math.abs(delta) < drinkThreshold) {
                continue;
            }

            const event = this.classifyEvent({
                mode: "adjacent",
                before,
                after,
                delta,
                drinkThreshold,
            });

            events.push(event);
        }

        return events;
    }
}