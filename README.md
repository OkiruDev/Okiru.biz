# Okiru.biz

This repository contains the Okiru.biz Vite / React site.

## Deployment

- GitHub repository: https://github.com/OkiruDev/Okiru.biz.git
- Railway service: deploy from this repo with the following settings:
  - Root directory: .
  - Build command: pnpm install && pnpm run build
  - Start command: pnpm run preview -- --host 0.0.0.0 --port $PORT
  - Environment variables:
    - PORT=3000
    - BASE_PATH=/
