// Reads configuration from environment variables and fails fast on anything missing or unsafe.

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer, got "${value}"`);
  return n;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const required = (name) => {
    if (!env[name]) errors.push(`${name} is required`);
    return env[name];
  };

  const config = {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL || 'info',

    mongoUri: required('MONGODB_URI'),
    mongoDb: env.MONGODB_DB || 'pstryk',

    mqttUrl: required('MQTT_URL'),
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    mqttClientId: env.MQTT_CLIENT_ID || undefined,

    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: required('ADMIN_PASSWORD'),

    allowQueryToken: bool(env.ALLOW_QUERY_TOKEN, false),
    rateLimitMax: int(env.RATE_LIMIT_MAX, 60),
    bodyLimit: int(env.BODY_LIMIT, 64 * 1024),
    callLogDays: int(env.CALL_LOG_DAYS, 30),
  };

  if (config.adminPassword && config.adminPassword.length < 12) {
    errors.push('ADMIN_PASSWORD must be at least 12 characters');
  }
  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return config;
}
