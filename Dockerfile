FROM node:24-bullseye-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY scripts ./scripts
COPY artifacts ./artifacts
COPY lib ./lib

RUN corepack enable && corepack prepare pnpm@10.15.1 --activate && pnpm install --frozen-lockfile

ENV PORT=3000
ENV HOST=0.0.0.0
ENV BASE_PATH=/

WORKDIR /app/artifacts/okiru-toolkit
RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "run", "serve"]
