import { app, InvocationContext, Timer } from "@azure/functions";

export async function timerTrigger(myTimer: Timer, context: InvocationContext): Promise<void> {
    context.log('Timer function processed request.');
    context.log(process.env.duration);
    // get sensor data from cosmos db
    // data format: { "timestamp": (unix time), "value": 8361000 }
    // 1. sort data by timestamp
    // 2. check data in the past $duration seconds
    // 3. if the value decreased more than $threshold, it is ok.
    // 4. if the value increased more than $threshold, it is ok.
    // 5. if the value does not change more than $threshold, it is not ok.
    // 6. send alert using sendAlert() function if it is not ok.

    const duration = parseInt(process.env.duration || '60'); // default to 60 seconds
    const threshold = parseInt(process.env.threshold || '100000'); // default to 100000
    const data = await getSensorData(); // get sensor data from cosmos db
    const now = Date.now();
    const pastData = data.filter((d: any) => d.timestamp >= now - duration * 1000);
    pastData.sort((a: any, b: any) => a.timestamp - b.timestamp);
    const firstValue = pastData[0].value;
    const lastValue = pastData[pastData.length - 1].value;
    const valueChange = lastValue - firstValue;
    if (Math.abs(valueChange) > threshold) {
        context.log('Value change is within acceptable range.');
    } else {
        context.log('Value change is not within acceptable range.');
        await sendAlert();
    }
}

app.timer('timerTrigger', {
    schedule: '*/10 * * * * *',
    handler: timerTrigger
});

async function getSensorData(): Promise<any[]> {
    const { CosmosClient } = require("@azure/cosmos");
    const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING || '');
    const database = client.database(process.env.COSMOS_DB_NAME || '');
    const container = database.container(process.env.COSMOS_DB_CONTAINER_NAME || '');
    const { resources: items } = await container.items.query('SELECT * FROM c').fetchAll();
    return items;
}

async function sendAlert(): Promise<void> {
    // send message and image to discord channel using webhook
    // don't use axios, use node-fetch instead
    const fetch = require('node-fetch');
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
    const message = {
        content: 'Alert: Value change is not within acceptable range'
    };
    await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
    });
}