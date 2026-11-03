// Fields the gateway adds to incoming requests (src/server.js). Read only by npm run typecheck.
import 'http';

declare module 'http' {
  interface IncomingMessage {
    clientAddress?: string;
    rateKey?: string;
    gatewayScope?: { appId: string; channel: string };
  }
}
