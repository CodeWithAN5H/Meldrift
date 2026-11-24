# Meldrift signaling service — self-hosted deployment.
# Build from the repository root so the shared protocol is included:
#   docker build -f server/Dockerfile -t meldrift-server .
# Run:
#   docker run -p 8787:8787 -v meldrift-data:/data meldrift-server

FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY server/package.json server/bun.lock ./server/
WORKDIR /app/server
RUN bun install --frozen-lockfile

COPY server/tsconfig.json ./tsconfig.json
COPY server/src ./src
COPY shared /app/shared
RUN bun build --compile --minify src/index.ts --outfile /app/meldrift-server

FROM alpine:3.20
RUN addgroup -S meldrift && adduser -S meldrift -G meldrift
WORKDIR /app
COPY --from=build /app/meldrift-server /usr/local/bin/meldrift-server
RUN mkdir -p /data && chown -R meldrift:meldrift /data
USER meldrift
ENV MELDRIFT_HOST=0.0.0.0 \
    MELDRIFT_PORT=8787 \
    MELDRIFT_DATA=/data/meldrift.db
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["meldrift-server"]
