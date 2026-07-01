import { ISensorRepository } from "../interfaces/ISensorRepository";
import { IControlRepository } from "../interfaces/IControlRepository";
import { INotifiler } from "../interfaces/INotifiler";
import { DrinkDetector } from "../domain/DrinkDetector";
import { DrinkStatusJudge, DrinkStatus } from "../domain/DrinkStatusJudge";

enum AlertStatus {
  Healthy = "Healthy",
  Alerting = "Alerting"
}

type DrinkMonitorConfig = {
  durationSec: number;
  drinkThreshold: number;
  pickupDropThreshold: number;
  returnLookahead: number;
  minPoints: number;
  cooldownSeconds: number;
  refillGraceSec: number;
  okImageUrl: string;
  ngImageUrl: string;
}

class DrinkMonitorService {
  private drinkMonitorConfig: DrinkMonitorConfig;
  private sensorRepository: ISensorRepository;
  private controlRepository: IControlRepository;
  private notifier: INotifiler;
  private detector: DrinkDetector;
  private judge: DrinkStatusJudge;
 
  constructor(
    sensorRepository: ISensorRepository,
    controlRepository: IControlRepository,
    notifier: INotifiler,
    detector: DrinkDetector,
    drinkMonitorConfig: DrinkMonitorConfig
  ) {
      this.sensorRepository = sensorRepository;
      this.controlRepository = controlRepository;
      this.notifier = notifier;
      this.detector = detector;
      this.drinkMonitorConfig = drinkMonitorConfig;
      this.judge = new DrinkStatusJudge(drinkMonitorConfig.refillGraceSec);
  }

  async execute(): Promise<void> {
    const points = await this.sensorRepository.getSensorData(this.drinkMonitorConfig.durationSec);

    if (points.length < this.drinkMonitorConfig.minPoints) {
      console.log("Not enough sensor data.", { count: points.length });
      console.log(points);
      return;
    }

    const events = this.detector.detect(
      points,
      this.drinkMonitorConfig.pickupDropThreshold,
      this.drinkMonitorConfig.drinkThreshold,
      this.drinkMonitorConfig.returnLookahead
    );

    const drinkStatus = this.judge.judge(events);

    console.log("Drink judgement", {
        points: points,
        events: JSON.stringify(events),
        drinkStatus
    });

    const control = await this.controlRepository.get();
    switch (drinkStatus) {
      case DrinkStatus.Healthy:
        console.log("Healthy: drink event detected.");
        if (control?.lastStatus !== AlertStatus.Healthy || (await this.canSendAlert())) {
            await this.notifier.send({
                level: "ok",
                content: "水筒の重さが減っています。",
                title: "娘ちゃんからひとこと",
                description: "パパ、その調子で水分とってね！",
                imageUrl: this.drinkMonitorConfig.okImageUrl,
                details: {
                    drinkThreshold: this.drinkMonitorConfig.drinkThreshold,
                    pickupDropThreshold: this.drinkMonitorConfig.pickupDropThreshold,
                    points: points.length,
                    events: events.length
                }
            });

            await this.controlRepository.update({
                lastStatus: AlertStatus.Healthy,
                lastAlertAt: new Date().toISOString()
            });
        } else {
          console.log(
              "Healthy alert skipped because last status was Healthy and cooldown is active."
          );
        }
        break;
      case DrinkStatus.RefillGrace:
        console.log("Refill detected recently. Skip alert during grace period.");
        break;
      case DrinkStatus.Alerting:
        if (control?.lastStatus !== AlertStatus.Alerting || (await this.canSendAlert())) {
          await this.notifier.send({
            level: "alert",
            content: "しばらく水筒の重さが減っていないようです。",
            title: "娘ちゃんからひとこと",
            description: "パパ、ちゃんと水分とってね！",
            imageUrl: this.drinkMonitorConfig.ngImageUrl,
            details: {
              drinkThreshold: this.drinkMonitorConfig.drinkThreshold,
              pickupDropThreshold: this.drinkMonitorConfig.pickupDropThreshold,
              points: points.length,
              events: events.length
            }
          });
          await this.controlRepository.update({
            lastStatus: AlertStatus.Alerting,
            lastAlertAt: new Date().toISOString()
          });
        } else {
          console.log(
            "Alert skipped because cooldown is active."
          );
        } 
        break;
    }
  }

  async canSendAlert(): Promise<boolean> {
    const control = await this.controlRepository.get();
    const now = Date.now();

    const lastAlert =
        control?.lastAlertAt
            ? new Date(control.lastAlertAt).getTime()
            : 0;

    return (
        now - lastAlert >
        this.drinkMonitorConfig.cooldownSeconds * 1000
    );
  }
}

export { DrinkMonitorService, DrinkMonitorConfig, AlertStatus };