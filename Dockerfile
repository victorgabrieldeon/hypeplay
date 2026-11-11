FROM oven/bun:1.4-slim
WORKDIR /app
ENV PORT=3003 DATA_DIR=/app/data
# 7z opens the games downloaded from vimm.net (server/vimm.ts).
RUN apt-get update && apt-get install -y --no-install-recommends 7zip && rm -rf /var/lib/apt/lists/*
# The Discord SDK (bundled into the entry page at startup), the fonts and sharp.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
# TabStationToo (PCSX2 in WebAssembly, GPL-3.0), each file checked by SHA-256 (emulator/ps2-fetch.ts): the PS2 games' player.
COPY emulator/ps2-fetch.ts emulator/ps2-files.json ./emulator/
RUN bun emulator/ps2-fetch.ts
COPY server ./server
COPY page ./page
# (scripts/restore.ts runs in this image: README "Backup automático")
COPY scripts ./scripts
EXPOSE 3003
CMD ["bun", "server/index.ts"]
