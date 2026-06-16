from machine import Pin
import requests
import SIM7672
import time
from umqtt.simple import MQTTClient
import json

MQTT_HOST = "beam.soracom.io"

SEND_INTERVAL = 5
READ_INTERVAL_MS = 500
WINDOW_SEC = 5

dt = Pin(14, Pin.IN)
sck = Pin(15, Pin.OUT)

modem = SIM7672.modem()
modem.active(True)
modem.connect("soracom.io", "sora", "sora", "IP", 3)


def reset_hx711():
    sck.value(1)
    time.sleep_us(100)
    sck.value(0)
    time.sleep_us(100)


def read_hx711():
    data = 0

    while dt.value() != 0:
        pass

    time.sleep_us(10)

    for _ in range(24):
        sck.value(1)
        time.sleep_us(5)
        sck.value(0)
        time.sleep_us(5)
        data = (data << 1) | dt.value()

    sck.value(1)
    time.sleep_us(10)
    sck.value(0)
    time.sleep_us(10)

    return data ^ 0x800000


def collect_window():
    samples = []
    start = time.ticks_ms()

    while time.ticks_diff(time.ticks_ms(), start) < WINDOW_SEC * 1000:
        value = read_hx711()
        if value == 0x7FFFFF:
            continue

        samples.append((time.ticks_ms(), value))
        time.sleep_ms(READ_INTERVAL_MS)

    return samples


def median(values):
    s = sorted(values)
    n = len(s)
    if n % 2:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) // 2


def moving_average(values):
    return sum(values) // len(values)


def calc_slope(samples):
    first_t, first_v = samples[0]
    last_t, last_v = samples[-1]

    dt_sec = time.ticks_diff(last_t, first_t) / 1000
    if dt_sec <= 0:
        return 0

    return (last_v - first_v) / dt_sec


def summarize(samples):
    values = [v for _, v in samples]

    return {
        "median": median(values),
        "average": moving_average(values),
        "min": min(values),
        "max": max(values),
        "range": max(values) - min(values),
        "slope": calc_slope(samples),
        "count": len(values)
        # raw はまず外す
    }


def mqtt_connect(client):
    client.connect(clean_session=True)
    print("mqtt connected")


def mqtt_publish(client, topic, payload, retries=3):
    body = json.dumps(payload)

    for i in range(retries):
        try:
            client.publish(topic, body, qos=0)
            print("published:", body)
            return True
        except Exception as e:
            print("publish failed:", e)
            try:
                client.disconnect()
            except:
                pass
            time.sleep(2)
            try:
                mqtt_connect(client)
            except Exception as e2:
                print("reconnect failed:", e2)
                time.sleep(2)

    print("mqtt publish skipped")
    return False