import { render } from './template.js';

/**
 * Renders every action of a hook, then publishes them in order.
 * Rendering happens up front so a bad request publishes nothing rather than a partial set.
 */
export async function fireHook(hook, ctx, publisher) {
  const messages = hook.actions.map((action) => ({
    topic: render(action.topic, ctx, { topic: true }),
    payload: render(action.payload ?? '', ctx),
    qos: action.qos ?? 0,
    retain: Boolean(action.retain),
  }));
  for (const message of messages) await publisher.publish(message);
  return messages;
}

export function buildContext(hook, { body, query }) {
  const now = new Date();
  return {
    body: body ?? {},
    query: query ?? {},
    hook: { name: hook.name },
    now: now.toISOString(),
    ts: now.getTime(),
  };
}
