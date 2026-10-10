FROM node:24-alpine AS build
WORKDIR /app
# Only the manifests, so npm ci stays cached until dependencies change. The
# cache mount keeps the npm cache between builds, so a lockfile change only
# downloads the packages that changed.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# One install for both: build with dev dependencies, then drop them.
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY server.js ./
# Run unprivileged. .data is the only writable path; on the VM it is a bind
# mount that must be owned by uid 1000 (see docs/oracle-deployment.md).
RUN mkdir -p .data && chown node:node .data
USER node
CMD ["node", "server.js"]
