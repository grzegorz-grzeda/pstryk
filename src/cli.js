#!/usr/bin/env node
// Admin account maintenance from the command line, for when you can't (or shouldn't) use the web UI.
//
//   node src/cli.js <command> [username]
//
// In Docker: docker compose exec pstryk node src/cli.js <command> [username]

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { checkPasswordPolicy, hashPassword } from './auth/passwords.js';
import { LoginThrottle } from './auth/throttle.js';
import { MongoStore } from './store.js';
import { USERNAME } from './routes/admin/util.js';
import { VERSION } from './version.js';

const USAGE = `Usage: node src/cli.js <command> [username]

Commands:
  list-admins                 List admin accounts
  create-admin <username>     Create an admin (prompts for a password)
  reset-password <username>   Set a new password and sign out all their sessions
  disable-2fa <username>      Turn off two-factor authentication (e.g. lost phone)
  unlock <username>           Clear a sign-in lockout for the username
  revoke-sessions <username>  Sign out all their sessions

Needs MONGODB_URI (and optionally MONGODB_DB) in the environment.`;

const audit = (store, action, username) =>
  store.logAudit({ action, actor: 'cli', ip: null, detail: { username, via: 'cli' } });

async function newPassword(io, username) {
  const password = await io.prompt('New password: ', { hidden: true });
  const again = await io.prompt('Repeat password: ', { hidden: true });
  if (password !== again) throw new Error('Passwords do not match');
  const problems = checkPasswordPolicy(password, username);
  if (problems.length) throw new Error(problems.join('. '));
  return hashPassword(password);
}

/** Runs one command. Returns the process exit code. */
export async function runCli([command, username], { store, io }) {
  const requireAdmin = async () => {
    const admin = username && (await store.getAdminByUsername(username.toLowerCase()));
    if (!admin) throw new Error(`No admin named "${username ?? ''}"`);
    return admin;
  };

  switch (command) {
    case 'list-admins': {
      const admins = await store.listAdmins();
      if (!admins.length) io.out('No admin accounts.');
      for (const a of admins) {
        io.out(`${a.username}\t2FA ${a.totpSecret ? 'on' : 'off'}\tlast sign-in ${a.lastLoginAt?.toISOString() ?? 'never'}`);
      }
      return 0;
    }
    case 'create-admin': {
      const name = String(username ?? '').toLowerCase();
      if (!USERNAME.test(name)) throw new Error('Invalid username: use a-z, 0-9, ., - and _ (max 64 characters)');
      await store.createAdmin({ username: name, passwordHash: await newPassword(io, name) });
      await audit(store, 'admin.create', name);
      io.out(`Created admin ${name}.`);
      return 0;
    }
    case 'reset-password': {
      const admin = await requireAdmin();
      await store.updateAdmin(admin._id, { passwordHash: await newPassword(io, admin.username), passwordChangedAt: new Date() });
      await store.deleteSessions(admin._id);
      await new LoginThrottle(store).unlock(admin.username);
      await audit(store, 'password.change', admin.username);
      io.out(`Password for ${admin.username} changed; all their sessions were signed out.`);
      return 0;
    }
    case 'disable-2fa': {
      const admin = await requireAdmin();
      await store.updateAdmin(admin._id, { totpSecret: null, totpLastStep: -1 });
      await audit(store, '2fa.disable', admin.username);
      io.out(`Two-factor authentication turned off for ${admin.username}. Ask them to set it up again.`);
      return 0;
    }
    case 'unlock': {
      if (!username) throw new Error('Username required');
      await new LoginThrottle(store).unlock(username);
      io.out(`Cleared sign-in lockout for ${username.toLowerCase()}. IP-based lockouts expire on their own.`);
      return 0;
    }
    case 'revoke-sessions': {
      const admin = await requireAdmin();
      await store.deleteSessions(admin._id);
      await audit(store, 'session.revoke_others', admin.username);
      io.out(`Signed out all sessions of ${admin.username}.`);
      return 0;
    }
    default:
      io.out(USAGE);
      return command && command !== 'help' && command !== '--help' ? 2 : 0;
  }
}

function terminalIo() {
  const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  return {
    out: (line) => console.log(line),
    async prompt(question, { hidden = false } = {}) {
      process.stdout.write(question);
      if (!(hidden && process.stdin.isTTY)) return String((await lines.next()).value ?? '');
      // Read the password without echoing it.
      return new Promise((resolve, reject) => {
        let value = '';
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const onData = (chunk) => {
          for (const char of chunk.toString('utf8')) {
            if (char === '\r' || char === '\n') {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              process.stdin.off('data', onData);
              process.stdout.write('\n');
              return resolve(value);
            }
            if (char === '\u0003') {
              process.stdin.setRawMode(false);
              return reject(new Error('Cancelled'));
            }
            if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
            else value += char;
          }
        };
        process.stdin.on('data', onData);
      });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--version') {
    console.log(VERSION);
    process.exit(0);
  }
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  const store = await MongoStore.connect({
    uri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB || 'pstryk',
    callLogDays: Number.parseInt(process.env.CALL_LOG_DAYS || '30', 10),
  });
  let code = 1;
  try {
    code = await runCli(args, { store, io: terminalIo() });
  } catch (err) {
    console.error(`Error: ${err.message}`);
  } finally {
    await store.close();
  }
  process.exit(code);
}
