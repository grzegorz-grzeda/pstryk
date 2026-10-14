import { fakeVerify, verifyPassword } from '../../auth/passwords.js';

/** A trimmed string form field, or '' if missing. */
export const field = (body, name, maxLength = 1000) =>
  typeof body?.[name] === 'string' ? body[name].trim().slice(0, maxLength) : '';

/** A password field. Not trimmed; anything over 256 characters is rejected outright. */
export const passwordField = (body, name) => {
  const value = body?.[name];
  return typeof value === 'string' && value.length <= 256 ? value : '';
};

export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Re-checks the signed-in admin's password before a sensitive change. Wrong guesses count
 * towards the same lockout as the sign-in form, so a hijacked session can't be used to
 * brute-force the password.
 * Returns null when the password is correct, otherwise an error message.
 */
export async function confirmPassword({ throttle, audit }, request, password) {
  const { admin } = request;
  if (await throttle.lockedUntil(request.ip, admin.username)) {
    await fakeVerify(password);
    return 'Too many failed attempts. Try again later.';
  }
  if (password && (await verifyPassword(password, admin.passwordHash))) return null;
  await throttle.recordFailure(request.ip, admin.username);
  await audit(request, 'login.failure', { username: admin.username, context: 're-authentication' });
  return 'Current password is incorrect';
}
