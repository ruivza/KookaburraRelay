// Every HTTP route the gateway serves besides the console files. A route names its method, path, how callers
// authenticate, the rate limit counted once the body is read, the audit action recorded when it succeeds, and the
// handler. Paths take :name for one ID segment; :name(a|b) restricts the segment to the listed values.
//
// auth: 'admin' (console session; the server checks it for every /admin/ path before routing, so unknown admin
// paths answer 401), 'monitor' (monitor token, checked by path before the body is read), 'device' (registration
// credential), 'server' (trusted-server credential) or 'none'. Device and server credentials are checked by
// the handlers, after their own rate limits.
// limit: [name, maximum, window] counts `name:<client>` per window.
// audit: an action name, or a function of the request context, recorded with the response status.
// A handler returns { status = 200, value, appId, channel }, or nothing when it has already responded.
export function route(method, pattern, options, handler) {
  const keys = [];
  const source = pattern.replace(/:(\w+)(?:\(([^)]+)\))?/g, (_, key, choices) => {
    keys.push(key);
    return '(' + (choices ?? '[A-Za-z0-9_-]+') + ')';
  });
  return {
    method,
    pattern,
    // Logged instead of the request path, so identifiers never reach logs.
    name: pattern.replace(/\([^)]+\)/g, ''),
    keys,
    regex: new RegExp('^' + source + '$'),
    auth: 'none',
    ...options,
    handler,
  };
}
export function match(routes, method, path) {
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const found = entry.regex.exec(path);
    if (found) return { route: entry, params: Object.fromEntries(entry.keys.map((key, i) => [key, found[i + 1]])) };
  }
  return null;
}
export const routeName = (routes, path) => routes.find(entry => entry.regex.test(path))?.name ?? '/unknown';
