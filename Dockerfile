# HiveMind backend: Telegram bot (long-polling) + onboarding HTTP API.
# Runs on any always-on container host (Koyeb, Fly, Render, a VPS).
FROM node:20-slim

# pnpm comes from corepack; the exact version is pinned by the repo's
# "packageManager" field, so no version drift.
RUN corepack enable
WORKDIR /app

COPY . .

# Install ALL deps including dev: the bot is launched with `tsx`, which is a
# root devDependency. --prod=false keeps it even if the host sets NODE_ENV=production.
RUN pnpm install --frozen-lockfile --prod=false

# The onboarding API binds to $PORT (injected by the host); 8000 is Koyeb's default.
ENV NODE_ENV=production
EXPOSE 8000

CMD ["pnpm", "bot"]
