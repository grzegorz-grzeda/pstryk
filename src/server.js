import pino from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPublisher } from './mqtt.js';
import { MongoStore } from './store.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = pino({ level: config.logLevel });
const store = await MongoStore.connect({ uri: config.mongoUri, dbName: config.mongoDb, callLogDays: config.callLogDays });
const publisher = createPublisher(config, logger.child({ component: 'mqtt' }));
const app = await buildApp({ config, store, publisher, logger });

const shutdown = async (signal) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await publisher.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
