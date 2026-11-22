# syntax=docker/dockerfile:1

# ---------- 构建阶段：安装全部依赖并产出 dist ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts 阻止依赖的安装期脚本执行；本项目无需任何 postinstall
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段：只保留 dist + server + python3 ----------
FROM node:24-bookworm-slim

# python3 用于运行用户的保活脚本，ca-certificates 供 HTTPS 出站。
# tini 作为 PID 1 回收孤儿进程：平台会不断 fork/退出 python 子进程，没有 init
# 时 node 作为 PID 1 不会被内核回收僵尸，长期运行会耗尽进程表。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    WB_HOST=0.0.0.0 \
    WB_DATA_DIR=/app/data \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=build /app/dist ./dist
COPY server ./server
# 数据目录必须先存在并归 node 所有。命名卷首次挂载时会继承镜像里该路径的
# 属主，因此这里 chown 之后，即使挂载空卷也不会出现写权限不足。
RUN mkdir -p /app/data && chown -R node:node /app/data /app

USER node
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.mjs"]
