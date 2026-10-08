FROM node:24-alpine
RUN apk add --no-cache age
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node *.js *.mjs *.sql *.html *.css ./
COPY --chown=node:node assets ./assets
RUN mkdir -p /app/data && chmod 0700 /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=3220 GATEWAY_DATA_DIR=/app/data
EXPOSE 3220
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3220/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
