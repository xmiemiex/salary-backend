# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/shared packages/shared
COPY prisma prisma
RUN pnpm prisma:generate \
    && pnpm --filter @salary/shared build \
    && pnpm --filter @salary/api build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist

# The production release-gate performs read-only checks against these repository
# assets. Keep this list deliberately narrow so the runtime image can prove the
# checks without containing the full source tree or any release credentials.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:node /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build --chown=node:node /app/apps/api/src/audit/audit-sanitizer.ts ./apps/api/src/audit/audit-sanitizer.ts
COPY --chown=node:node scripts/check-environment.ps1 scripts/e2e-permissions.ts ./scripts/
COPY --chown=node:node docs/e2e-permissions.md ./docs/e2e-permissions.md
COPY --chown=node:node apps/web/src/pages/system-health-utils.ts ./apps/web/src/pages/system-health-utils.ts

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
