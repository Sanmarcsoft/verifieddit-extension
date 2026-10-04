# Build context: repository root (e.g. docker build -f relay/Dockerfile .)
FROM oven/bun:1.4.0-alpine

USER bun
WORKDIR /app

COPY --chown=bun:bun relay/src ./src

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD bun -e 'fetch("http://localhost:" + (process.env.PORT || 3000) + "/healthz").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["bun", "run", "src/main.ts"]
