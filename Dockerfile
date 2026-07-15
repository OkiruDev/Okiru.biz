FROM node:24-bullseye-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY artifacts ./artifacts
COPY lib ./lib

RUN corepack enable && corepack prepare pnpm@10.15.1 --activate && pnpm install --frozen-lockfile

WORKDIR /app/artifacts/okiru-toolkit
RUN pnpm run build

ENV PORT=3000
ENV HOST=0.0.0.0
ENV BASE_PATH=/

EXPOSE 3000

CMD ["pnpm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "3000"]
