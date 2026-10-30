# The PS2 library's builder (ps2-builder/builder.ts): compiles each PS2 game sent through the activity with
# ps2-web-recomp's scripts/port.sh. The image holds the toolchain and the recompiler's source only, never anything from
# a disc: that lives in the data volume (/app/data/ps2/, /app/data/ps2-work/), and so does everything made from it.
# Built from the repository's root (docker-compose.yml): it uses builder/builder.ts and server/games.ts too.
FROM oven/bun:1.4 AS bun

FROM debian:trixie-slim
# clang/g++ with <format> (scripts/cxx.sh), cmake + ninja, python3 (+ Pillow for the screenshots), 7z for .7z images,
# curl + unzip for wgpu-native (scripts/fetch_wgpu.sh), git + xz for the Emscripten SDK.
RUN apt-get update \
  && apt-get install -y --no-install-recommends clang lld g++ cmake ninja-build python3 python3-pil p7zip-full git \
     ca-certificates curl unzip xz-utils bash \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# The recompiler at a fixed commit: ps2-builder/patch.ts is checked against this one.
ARG RECOMP_REPO=https://github.com/snuri00/ps2-web-recomp.git
ARG RECOMP_COMMIT=e026b971324068773eed88bf502437de9e581b6b
RUN git init -q /opt/recomp \
  && git -C /opt/recomp fetch -q --depth 1 "$RECOMP_REPO" "$RECOMP_COMMIT" \
  && git -C /opt/recomp checkout -q FETCH_HEAD \
  && rm -rf /opt/recomp/.git
# The Emscripten SDK it pins (6.0.11), wgpu-native for the headless test runs, and its two recompilers.
RUN EMSDK=/opt/recomp/tools/emsdk /opt/recomp/scripts/setup.sh

WORKDIR /opt/cordplay
COPY builder/builder.ts builder/patch.ts builder/
COPY server/games.ts server/
COPY ps2-builder/builder.ts ps2-builder/patch.ts ps2-builder/shots.py ps2-builder/
ENV RECOMP=/opt/recomp DATA=/app/data EMSDK=/opt/recomp/tools/emsdk
CMD ["bun", "ps2-builder/builder.ts"]
