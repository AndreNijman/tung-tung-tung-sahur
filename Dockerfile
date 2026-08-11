FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node index.html CNAME package.json ./
COPY --chown=node:node server ./server

USER node
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1

CMD ["node", "server/relay.js", "--serve", "."]
