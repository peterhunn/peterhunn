FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/dashboard/package.json ./packages/dashboard/
RUN npm ci --ignore-scripts --workspace @x490/dashboard

FROM deps AS build
COPY packages/dashboard ./packages/dashboard/
RUN npm run build -w @x490/dashboard

FROM node:22-alpine AS run
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/dashboard/.next ./packages/dashboard/.next
COPY --from=build /app/packages/dashboard/package.json ./packages/dashboard/
COPY --from=build /app/packages/dashboard/public ./packages/dashboard/public 2>/dev/null || true
COPY --from=build /app/package.json ./
ENV NODE_ENV=production
WORKDIR /app/packages/dashboard
EXPOSE 3001
CMD ["node_modules/.bin/next", "start", "-p", "3001"]
