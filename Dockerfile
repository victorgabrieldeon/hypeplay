# The PC app (app/), offered by the home at p/<pass>/app/<system>: built for Linux on Ubuntu 22.04 (glibc 2.35, what
# PCSX2's own AppImage needs too) and for Windows with MinGW, then packed with PCSX2 (GPL-3.0, both files checked by
# SHA-256: the Linux one opened up, so no FUSE on the players' PCs) and servidor.txt, the address the app signs in at.
FROM ubuntu:22.04 AS app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev gcc-mingw-w64-x86-64 p7zip-full zip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain 1.99.1 --target x86_64-pc-windows-gnu
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /build
ARG PCSX2=v2.8.2
RUN curl -sSfL -o pcsx2.AppImage "https://github.com/PCSX2/pcsx2/releases/download/$PCSX2/pcsx2-$PCSX2-linux-appimage-x64-Qt.AppImage" \
  && curl -sSfL -o pcsx2.7z "https://github.com/PCSX2/pcsx2/releases/download/$PCSX2/pcsx2-$PCSX2-windows-x64-Qt.7z" \
  && printf '%s  %s\n' 0c46bb6a88aa2782b10853a7b07cf3387ba99cbef2b966372cd2315b8571abea pcsx2.AppImage \
       7dfc829ca1994cc1045ac49f05e39b6cf968b72e6a374c40e05c2a2b4ac200b4 pcsx2.7z | sha256sum -c - \
  && chmod +x pcsx2.AppImage && ./pcsx2.AppImage --appimage-extract >/dev/null && mv squashfs-root pcsx2-linux && rm pcsx2.AppImage \
  && 7z x -opcsx2-windows pcsx2.7z >/dev/null && rm pcsx2.7z \
  && test -x pcsx2-linux/AppRun && test -f pcsx2-windows/pcsx2-qt.exe \
  # (a portable.ini/txt would make PCSX2 ignore -datapath, where the app keeps its BIOS and cards)
  && ! ls pcsx2-linux/usr/bin/portable.* pcsx2-windows/portable.* 2>/dev/null
COPY app/Cargo.toml app/Cargo.lock ./
COPY app/src ./src
# (the build and the crates go in this same step: ~3 GB the server's build cache has no need to keep, rebuilt in a few
# minutes only when app/ changes)
RUN cargo build --release --locked --target x86_64-unknown-linux-gnu --target x86_64-pc-windows-gnu \
  && mkdir -p /out/linux/HypePlay /out/windows/HypePlay \
  && cp target/x86_64-unknown-linux-gnu/release/hypeplay /out/linux/HypePlay/hypeplay \
  && cp target/x86_64-pc-windows-gnu/release/hypeplay.exe /out/windows/HypePlay/HypePlay.exe \
  && rm -rf target /root/.cargo/registry /root/.cargo/git
COPY server/fixtures/COPYING.GPLv3 ./
# (the server's public address, from the compose's build args: without it the home offers no app)
ARG PUBLIC_URL=""
RUN for os in linux windows; do \
    dir=/out/$os/HypePlay; mv pcsx2-$os $dir/pcsx2 && cp COPYING.GPLv3 $dir/pcsx2/ \
    && printf 'PCSX2 %s, GPL-3.0 (a licença está em COPYING.GPLv3). Código-fonte: https://github.com/PCSX2/pcsx2/tree/%s\n' "$PCSX2" "$PCSX2" > $dir/pcsx2/LEIA-ME.txt \
    && printf '%s\n' "$PUBLIC_URL" > $dir/servidor.txt; done \
  && tar -C /out/linux -czf /out/HypePlay-linux.tar.gz HypePlay \
  && (cd /out/windows && zip -qr9 /out/HypePlay-windows.zip HypePlay) \
  && rm -rf /out/linux /out/windows

FROM oven/bun:1.4-slim
WORKDIR /app
ENV PORT=3003 DATA_DIR=/app/data
# 7z opens the games downloaded from vimm.net (server/vimm.ts).
RUN apt-get update && apt-get install -y --no-install-recommends 7zip && rm -rf /var/lib/apt/lists/*
# Only the Discord SDK, bundled into the entry page at startup. Nothing of the game: the builder makes it in the volume.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
# TabStationToo (PCSX2 in WebAssembly, GPL-3.0), each file checked by SHA-256 (emulator/ps2-fetch.ts): the PS2 games' player.
COPY emulator/ps2-fetch.ts emulator/ps2-files.json ./emulator/
RUN bun emulator/ps2-fetch.ts
# The PC app's packages (routes.ts APP_FILES).
COPY --from=app /out/HypePlay-linux.tar.gz /out/HypePlay-windows.zip ./downloads/
COPY server ./server
COPY page ./page
EXPOSE 3003
CMD ["bun", "server/index.ts"]
