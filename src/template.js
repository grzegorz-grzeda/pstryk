// Minimal {{ path }} templating for MQTT topics and payloads.
//
//   {{body.room}}        value from the request body
//   {{query.level}}      value from the query string
//   {{hook.name}} {{now}} {{ts}}
//   {{body.msg|json}}    JSON-encoded (strings get quotes and escaping)
//
// Objects and arrays are always inserted as JSON. A missing value is an error,
// so a malformed request never publishes a half-filled message.

const TAG = /\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+)*)\s*(?:\|\s*(json)\s*)?\}\}/g;

export class TemplateError extends Error {}

function lookup(ctx, path) {
  let value = ctx;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function format(value, filter) {
  if (filter === 'json') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * @param {string} template
 * @param {object} ctx
 * @param {{ topic?: boolean }} [opts] topic mode rejects values that would change the topic structure
 */
export function render(template, ctx, opts = {}) {
  return template.replace(TAG, (_, path, filter) => {
    const value = lookup(ctx, path);
    if (value === undefined) throw new TemplateError(`Missing value for {{${path}}}`);
    const text = format(value, filter);
    if (opts.topic && /[/+#\u0000]/.test(text)) {
      throw new TemplateError(`Value for {{${path}}} may not contain "/", "+", "#" in a topic`);
    }
    return text;
  });
}

/** Returns a list of problems with a template, or an empty list. */
export function checkTemplate(template, { topic = false } = {}) {
  const problems = [];
  const leftovers = template.replace(TAG, '');
  if (leftovers.includes('{{') || leftovers.includes('}}')) problems.push('Malformed {{ }} placeholder');
  if (topic) {
    if (!template.trim()) problems.push('Topic is required');
    if (/[+#\u0000]/.test(template)) problems.push('Topic may not contain wildcards "+" or "#"');
    if (template.startsWith('$')) problems.push('Topic may not start with "$"');
    if (Buffer.byteLength(template) > 1024) problems.push('Topic is too long');
  }
  return problems;
}
