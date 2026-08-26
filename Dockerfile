# ---- Builder stage：装全量依赖（含 dev）并把 TS 编译成 JS ----
FROM node:22-alpine AS builder
WORKDIR /app
# 先只拷 package.json，让 npm install 命中缓存层。
COPY package.json ./
RUN npm install
# 再拷源码做编译。
COPY tsconfig.json ./
COPY src ./src
COPY run_agent.ts ./
RUN npm run build

# ---- Runtime stage：只保留 prod 依赖和编译产物，体积最小 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# prod 依赖
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
# 编译产物
COPY --from=builder /app/dist ./dist
# 暴露 8001（与 AGENT_INTEGRATION.md 对齐；容器内由 docker 网络中的 Python 调用，不对外暴露）。
EXPOSE 8001
# 直接 node 跑编译后的 JS，不再走 tsx。
CMD ["node", "dist/src/server.js"]