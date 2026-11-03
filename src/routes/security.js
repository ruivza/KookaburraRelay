import { route } from '../router.js';

export function securityRoutes({ security, bearer }) {
  const action = (path, method) =>
    route(
      'POST',
      '/admin/security/' + path,
      { auth: 'admin', limit: ['security', 10, 60000], audit: 'security.' + method },
      async ({ body }) => ({ value: await security[method](body) }),
    );
  return [
    route('POST', '/auth/login', { limit: ['login', 20, 60000] }, async ({ body }) => ({
      value: await security.login(body),
    })),
    route('GET', '/admin/security', { auth: 'admin' }, async () => ({ value: await security.status() })),
    action('token', 'changeToken'),
    action('setup', 'setup'),
    action('confirm', 'confirm'),
    action('disable', 'disable'),
    route('POST', '/admin/logout', { auth: 'admin' }, async ({ req }) => {
      await security.logout(bearer(req));
      return { value: { signedOut: true } };
    }),
  ];
}
