FROM oven/bun:1.4-slim
WORKDIR /app
ENV PORT=3003 BT3_DIR=/app/data/bt3
# Only Bun built-ins at runtime: no node_modules. Nothing of the game: the builder makes it in the volume.
COPY server ./server
COPY page ./page
EXPOSE 3003
CMD ["bun", "server/index.ts"]
