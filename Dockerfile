FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev

COPY . .
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/build"
RUN npx prisma generate && npm run build

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R node:node /app /entrypoint.sh

USER node
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
