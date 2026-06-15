FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST=https://us.i.posthog.com
ENV VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY
ENV VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# docker CLI so the app can run each workflow step in a sibling container
# (CODE_RUNTIME=docker). Talks to the host daemon via the mounted socket.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src/ ./src/
COPY --from=web /app/web/dist ./web/dist
# stamp the build time so the app can tell self-hosters when a newer version exists
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.build-time
EXPOSE 8787
CMD ["npm", "run", "start"]
