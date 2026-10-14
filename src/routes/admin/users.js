import { checkPasswordPolicy, hashPassword } from '../../auth/passwords.js';
import { DuplicateError } from '../../store.js';
import { usersPage } from '../../views/account.js';
import { confirmPassword, field, passwordField, USERNAME } from './util.js';

export default async function userRoutes(app, ctx) {
  const { store, audit, render, redirectWith } = ctx;
  const back = (request, reply, flash) => redirectWith(request, reply, '/admin/users', flash);

  app.get('/users', async (request, reply) => {
    const admins = await store.listAdmins();
    return render(request, reply, { title: 'Users', active: 'users' }, usersPage({ admins, admin: request.admin, csrf: request.session.csrf }));
  });

  app.post('/users', async (request, reply) => {
    const error = await confirmPassword(ctx, request, passwordField(request.body, 'currentPassword'));
    if (error) return back(request, reply, { error });

    const username = field(request.body, 'username', 100).toLowerCase();
    if (!USERNAME.test(username)) return back(request, reply, { error: 'Invalid username: use a-z, 0-9, ., - and _ (max 64 characters)' });
    const password = passwordField(request.body, 'newPassword');
    const problems = checkPasswordPolicy(password, username);
    if (problems.length) return back(request, reply, { error: problems.join('. ') });

    try {
      await store.createAdmin({ username, passwordHash: await hashPassword(password) });
    } catch (err) {
      if (err instanceof DuplicateError) return back(request, reply, { error: err.message });
      throw err;
    }
    await audit(request, 'admin.create', { username });
    return back(request, reply, { info: `Added admin ${username}.` });
  });

  app.post('/users/:id/delete', async (request, reply) => {
    const target = await store.getAdmin(request.params.id);
    if (!target) return back(request, reply, { error: 'No such admin' });
    if (target._id === request.admin._id) return back(request, reply, { error: "You can't delete your own account" });
    await store.deleteAdmin(target._id);
    await audit(request, 'admin.delete', { username: target.username });
    return back(request, reply, { info: `Deleted admin ${target.username}.` });
  });
}
