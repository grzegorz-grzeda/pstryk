import { checkPasswordPolicy, hashPassword } from './passwords.js';

/**
 * Makes sure at least one admin account exists. On the very first start, the account is
 * created from ADMIN_USER / ADMIN_PASSWORD; after that those variables are ignored.
 */
export async function ensureFirstAdmin(store, config, log) {
  if ((await store.countAdmins()) > 0) {
    if (config.adminPassword) log.warn('ADMIN_PASSWORD is only used to create the first admin. Remove it from the environment.');
    return;
  }
  if (!config.adminPassword) {
    throw new Error(
      'No admin account exists yet. Set ADMIN_USER and ADMIN_PASSWORD for the first start, ' +
        'or create one with: node src/cli.js create-admin <username>',
    );
  }
  const problems = checkPasswordPolicy(config.adminPassword, config.adminUser);
  if (problems.length) throw new Error(`ADMIN_PASSWORD is not acceptable: ${problems.join('. ')}`);

  await store.createAdmin({ username: config.adminUser, passwordHash: await hashPassword(config.adminPassword) });
  await store.logAudit({ action: 'admin.create', actor: null, ip: null, detail: { username: config.adminUser, via: 'environment' } });
  log.info({ username: config.adminUser }, 'Created first admin account. You can now remove ADMIN_PASSWORD from the environment.');
}
