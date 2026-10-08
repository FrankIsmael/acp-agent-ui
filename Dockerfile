FROM node:24-alpine AS development-dependencies-env
# Only the manifests, so npm ci stays cached until dependencies change.
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci

FROM node:24-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:24-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:24-alpine
COPY ./package.json package-lock.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
COPY server.js /app/
WORKDIR /app
# Run unprivileged. .data is the only writable path; on the VM it is a bind
# mount that must be owned by uid 1000 (see docs/oracle-deployment.md).
RUN mkdir -p .data && chown node:node .data
USER node
CMD ["node", "server.js"]
