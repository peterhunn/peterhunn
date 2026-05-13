# Stage 1: deps
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/facilitator/package.json ./packages/facilitator/
COPY packages/dashboard/package.json ./packages/dashboard/
RUN npm ci --ignore-scripts

# Stage 2: build facilitator
FROM deps AS build
COPY packages/protocol/src ./packages/protocol/src
COPY packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/facilitator/src ./packages/facilitator/src
COPY packages/facilitator/tsconfig.json ./packages/facilitator/
COPY tsconfig.json ./
RUN npm run build -w @x490/protocol && npm run build -w @x490/facilitator

# Stage 3: build dashboard
FROM deps AS dashboard
COPY packages/dashboard ./packages/dashboard/
RUN npm run build -w @x490/dashboard

# Stage 4: run
FROM node:22-alpine AS run
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/packages/facilitator/dist ./packages/facilitator/dist
COPY --from=build /app/packages/facilitator/package.json ./packages/facilitator/
COPY --from=dashboard /app/packages/dashboard/out ./packages/dashboard/out
COPY --from=build /app/package.json ./
ENV NODE_ENV=production
EXPOSE 4901
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:${PORT:-4901}/health || exit 1
CMD ["node", "packages/facilitator/dist/server.js"]
