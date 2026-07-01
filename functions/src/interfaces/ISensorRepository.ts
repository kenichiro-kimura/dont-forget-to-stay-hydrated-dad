import { SensorPoint } from "../domain/SensorPoint";
export interface ISensorRepository {
    getSensorData(durationSec: number): Promise<SensorPoint[]>;
}