# syntax=docker/dockerfile:1.7
# One Dockerfile, three runtime targets (DigitalOcean App Platform builds each with --target):
#   web    – customer Next.js app (standalone output)
#   admin  – staff console (standalone output)
#   worker – pg-boss worker with FFmpeg; also runs `pnpm db:migrate` as the pre-deploy job
ARG NODE_VERSION=22.12
# App Platform passes BUILD_TIME env vars as build args; DOCKER_TARGET picks the final image.
ARG DOCKER_TARGET=web

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/worker/package.json apps/worker/
COPY packages/ packages/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @arkiv/web build && pnpm --filter @arkiv/admin build

# ── web ──
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN useradd -r -u 1001 arkiv
COPY --from=build --chown=arkiv /repo/apps/web/.next/standalone ./
COPY --from=build --chown=arkiv /repo/apps/web/.next/static ./apps/web/.next/static
USER arkiv
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ── admin ──
FROM node:${NODE_VERSION}-bookworm-slim AS admin
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN useradd -r -u 1001 arkiv
COPY --from=build --chown=arkiv /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=arkiv /repo/apps/admin/.next/static ./apps/admin/.next/static
USER arkiv
EXPOSE 8080
CMD ["node", "apps/admin/server.js"]

# ── worker (+ migrate job) ──
FROM base AS worker
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd -r -u 1001 arkiv
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/worker ./apps/worker
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
USER arkiv
CMD ["pnpm", "--filter", "@arkiv/worker", "start"]

# ── final: selected by DOCKER_TARGET (web | admin | worker); `docker build --target <name>` also works locally ──
FROM ${DOCKER_TARGET} AS final
