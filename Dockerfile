FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ENV NODE_ENV=production PORT=3009
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node src ./src
RUN mkdir -p logs src/tempFolder && chown node:node logs src/tempFolder
USER node
EXPOSE 3009
CMD ["node", "src/index.js"]
