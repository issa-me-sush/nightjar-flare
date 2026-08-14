# tee-proxy, built for Railway.
#
# Same build as proxy/Dockerfile — the upstream source is cloned at build time,
# so nothing needs pushing to a registry first. The only difference is that the
# config is rendered at startup from environment variables instead of being
# baked in, because it carries the indexer credentials and those should live in
# Railway's variables rather than in this repo or in an image layer.
#
# Keep TEE_PROXY_VERSION aligned with tools/go.mod. See scripts/check-versions.sh.

ARG TEE_PROXY_VERSION=v0.0.18

FROM golang:1.25.1-alpine AS builder
RUN apk add --no-cache git
ARG TEE_PROXY_VERSION
WORKDIR /app
RUN git clone --depth 1 --branch ${TEE_PROXY_VERSION} https://github.com/flare-foundation/tee-proxy.git
WORKDIR /app/tee-proxy
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -a -o main ./cmd/proxy

FROM alpine:3.21
WORKDIR /app

COPY --from=builder /app/tee-proxy/main .
COPY deploy/railway/proxy-entrypoint.sh /app/entrypoint.sh

RUN mkdir -p /app/config \
 && chmod +x /app/entrypoint.sh \
 && addgroup -g 1001 -S appgroup \
 && adduser -u 1001 -S appuser -G appgroup \
 && chown -R appuser:appgroup /app

USER appuser

# internal — the enclave reaches this over Railway's private network
EXPOSE 6663
# external — the frontend, and Flare's availability check, reach this
EXPOSE 6664

CMD ["/app/entrypoint.sh"]
