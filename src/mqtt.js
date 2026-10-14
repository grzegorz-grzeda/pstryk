import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';

export class PublishError extends Error {}

const PUBLISH_TIMEOUT_MS = 5000;

/** The broker URL without credentials, safe to log and display. */
export function brokerLabel(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid URL';
  }
}

/** One long-lived MQTT connection shared by all hooks; mqtt.js reconnects on its own. */
export function createPublisher(config, log) {
  const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: config.mqttClientId || `pstryk-${randomBytes(4).toString('hex')}`,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    queueQoSZero: false,
  });

  // For the dashboard: when the current connection came up, and the latest error.
  let connectedSince = null;
  let lastError = null;
  client.on('connect', () => {
    connectedSince = new Date();
    log.info({ broker: brokerLabel(config.mqttUrl) }, 'MQTT connected');
  });
  client.on('offline', () => {
    connectedSince = null;
    log.warn('MQTT offline');
  });
  client.on('error', (err) => {
    lastError = { message: err.message, at: new Date() };
    log.error({ err }, 'MQTT error');
  });

  return {
    get connected() {
      return client.connected;
    },

    get status() {
      return { connected: client.connected, since: connectedSince, lastError, broker: brokerLabel(config.mqttUrl) };
    },

    async publish({ topic, payload, qos, retain }) {
      // Fail fast instead of queueing: the caller should know the message was not delivered.
      if (!client.connected) throw new PublishError('MQTT broker is not connected');
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PublishError('MQTT publish timed out')), PUBLISH_TIMEOUT_MS);
      });
      try {
        await Promise.race([client.publishAsync(topic, payload, { qos, retain }), timeout]);
      } catch (err) {
        throw err instanceof PublishError ? err : new PublishError(err.message);
      } finally {
        clearTimeout(timer);
      }
    },

    close() {
      return client.endAsync();
    },
  };
}
