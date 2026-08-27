FROM node:22.22.0-alpine AS build

WORKDIR /app
RUN apk add --no-cache g++ make python3
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.server-build.json ./
COPY src ./src
COPY server ./server
RUN npm run build && npm prune --omit=dev

FROM node:22.22.0-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
CMD ["node", "server-dist/server/serve.js"]
