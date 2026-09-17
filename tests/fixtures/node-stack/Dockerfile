FROM node:20-alpine AS base
WORKDIR /app
ARG BUILD_VERSION
ENV NODE_ENV=production PORT=3000
ENV API_TOKEN=tok_live_DO_NOT_LEAK_0001
COPY . .
RUN npm ci
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD curl -f http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
