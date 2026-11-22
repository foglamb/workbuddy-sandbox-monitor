FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production WB_HOST=0.0.0.0 WB_DATA_DIR=/app/data
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8788
CMD ["node", "server/index.mjs"]
