FROM oven/bun:1.4-slim
WORKDIR /app
ENV PORT=3003 DATA_DIR=/app/data
# Only the Discord SDK, bundled into the entry page at startup. Nothing of the game: the builder makes it in the volume.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
# EmulatorJS and its cores, pinned and checked (emulator/fetch.ts): the homebrew games' player.
COPY emulator/fetch.ts ./emulator/
RUN bun emulator/fetch.ts
# TabStationToo (PCSX2 in WebAssembly, GPL-3.0), each file checked by SHA-256 (emulator/ps2-fetch.ts): the PS2 games' player.
COPY emulator/ps2-fetch.ts emulator/ps2-files.json ./emulator/
RUN bun emulator/ps2-fetch.ts
COPY server ./server
COPY page ./page
EXPOSE 3003
CMD ["bun", "server/index.ts"]
