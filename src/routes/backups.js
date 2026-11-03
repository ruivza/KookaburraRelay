import { route } from '../router.js';

export function backupRoutes({ backups }) {
  const change = { auth: 'admin', limit: ['backup-admin', 10, 60000] };
  return [
    route('GET', '/admin/backups', { auth: 'admin' }, async () => ({ value: await backups.status() })),
    route('PUT', '/admin/backups', { ...change, audit: 'backup.settings' }, async ({ body }) => ({
      value: await backups.save(body),
    })),
    route('POST', '/admin/backups/run', { ...change, audit: 'backup.run' }, async () => ({
      status: 202,
      value: await backups.enqueue(),
    })),
    route('POST', '/admin/backups/test', { ...change, audit: 'backup.test' }, async () => ({
      status: 202,
      value: await backups.enqueue('test'),
    })),
    route(
      'POST',
      '/admin/backups/:id([a-f0-9-]{36})/retry',
      { ...change, audit: 'backup.retry' },
      async ({ params }) => ({
        status: 202,
        value: await backups.retry(params.id),
      }),
    ),
  ];
}
