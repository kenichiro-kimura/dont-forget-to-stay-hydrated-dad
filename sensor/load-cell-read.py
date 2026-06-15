from machine import Pin
import time

dt = Pin(14, Pin.IN)      # DOUT
sck = Pin(15, Pin.OUT)    # SLK/SCK

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

    # 秋月サンプルと同じ処理
    return data ^ 0x800000

reset_hx711()

while True:
    v = read_hx711()
    print(v)
    time.sleep_ms(500)