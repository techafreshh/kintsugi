# Kintsugi demo image (issue #22): one image, multiple commands.
#   docker build -t kintsugi:latest .
#   docker run kintsugi:latest kintsugi api       # receiver dashboard + webhook API
#   docker run kintsugi:latest kintsugi worker    # repair-loop poller
#   docker run kintsugi:latest mock-upstream      # chaos mock upstream
# The default command serves the API; docker-compose.yml overrides it per service.

FROM node:22 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
RUN npm ci --omit=dev \
 && chmod +x dist/src/cli.js dist/src/mockupstream/app.js \
 && ln -s /app/dist/src/cli.js /usr/local/bin/kintsugi \
 && ln -s /app/dist/src/mockupstream/app.js /usr/local/bin/kintsugi-mock-upstream \
 && ln -s /app/dist/src/mockupstream/app.js /usr/local/bin/mock-upstream
EXPOSE 8080
CMD ["kintsugi", "api"]
