import { defaultApp } from '../applications.js';
import { notificationAlgorithm } from '../notification.js';
import { route } from '../router.js';

// Prometheus text for [name, value or [[labels, value], ...], help?] gauges.
export const gauges = metrics =>
  metrics
    .map(
      ([name, samples, help]) =>
        (help ? `# HELP ${name} ${help}\n` : '') +
        `# TYPE ${name} gauge\n` +
        (Array.isArray(samples) ? samples : [['', samples]])
          .map(([labels, value]) => `${name}${labels} ${value}\n`)
          .join(''),
    )
    .join('');
const attention = status => +!['ok', 'disabled'].includes(status);

export function publicRoutes({ applications, access, monitor, backups, scheduler, bearer }) {
  return [
    route('GET', '/v1/access', {}, async ({ query }) => ({
      value: await access.publicPolicy(query.get('appId') || defaultApp),
    })),
    route('POST', '/v1/server-tickets', { auth: 'server' }, async ({ req, body }) => ({
      value: await access.ticket(bearer(req), body),
    })),
    route('POST', '/v1/integrity/challenges', {}, async ({ req, body }) => ({
      value: await access.challenge(body, req.rateKey),
    })),
    route('GET', '/v1/status', {}, async ({ query }) => {
      const appId = query.get('appId') || defaultApp;
      const { ready, kinds } = await applications.publicStatus(appId, query.get('channel') || 'apns');
      return {
        value: {
          protocol: 1,
          appId,
          ready,
          notificationEncryption: kinds.includes('encrypted_alert') ? notificationAlgorithm : null,
          kinds,
        },
      };
    }),
    route('GET', '/metrics', { auth: 'monitor' }, async ({ res }) => {
      const v = await monitor.overview();
      const q = await monitor.queueStatus(),
        b = await backups.summary();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
      const metrics = [
        ['relay_gateway_queue_oldest_wait_seconds', q.oldestWaitSeconds],
        ['relay_gateway_queue_overdue', q.overdue],
        ['relay_gateway_sending_stuck', q.stuck],
        ['relay_gateway_worker_error', +q.workerError],
        ['relay_gateway_monitor_last_sample_seconds', (monitor.lastSampleAt ?? 0) / 1000],
        ['relay_gateway_backup_worker_online', +b.workerOnline],
        [
          'relay_gateway_backup_last_success_seconds',
          [
            ['{target="local"}', (b.local.lastSuccess ?? 0) / 1000],
            ['{target="remote"}', (b.remote.lastSuccess ?? 0) / 1000],
          ],
        ],
        [
          'relay_gateway_backup_attention',
          [
            ['{target="local"}', attention(b.local.status)],
            ['{target="remote"}', attention(b.remote.status)],
          ],
        ],
        ['relay_gateway_uptime_seconds', v.uptime / 1000, 'Current process uptime'],
        ['relay_gateway_queue_depth', v.queue],
        ['relay_gateway_memory_bytes', v.memory.rss],
        [
          'relay_gateway_tasks_24h',
          [
            ['{state="accepted"}', v.counts.accepted],
            ['{state="failed_or_unknown"}', v.counts.failed],
          ],
        ],
        [
          'relay_gateway_job_failures',
          scheduler.status().map(job => ['{job="' + job.name + '"}', job.failures]),
          'Failed runs of a periodic job since start',
        ],
        [
          'relay_gateway_job_last_success_seconds',
          scheduler.status().map(job => ['{job="' + job.name + '"}', (job.lastSuccess ?? 0) / 1000]),
        ],
      ];
      // 0.3.0 renamed perch_gateway_* to relay_gateway_*; the old names are still served for one release.
      const aliases = metrics.map(([name, samples]) => [
        name.replace(/^relay_/, 'perch_'),
        samples,
        'Deprecated alias of ' + name + ', removed in the next release',
      ]);
      res.end(gauges([...metrics, ...aliases]));
    }),
    route('POST', '/monitor/report', { auth: 'monitor' }, async ({ body }) => ({
      value: await monitor.report(body),
    })),
  ];
}
