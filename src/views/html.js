// Tiny HTML templating: `html` escapes every interpolated value unless it is already
// a SafeHtml (another html`` fragment) or an array of them.

export class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function interpolate(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escape(value);
}

export function html(strings, ...values) {
  return new SafeHtml(strings.reduce((out, str, i) => out + str + (i < values.length ? interpolate(values[i]) : ''), ''));
}

export const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'never');

/** Hidden CSRF field for every state-changing form. */
export const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;
