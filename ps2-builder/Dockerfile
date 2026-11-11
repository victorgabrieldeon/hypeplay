# The PS2 games' "versão rápida" builder (ps2-builder/builder.ts): compiles the PS2 games someone asks for with
# ps2-web-recomp's scripts/port.sh. The image holds the toolchain and the recompiler's source only, never anything from
# a disc: that lives in the data volume (/app/data/ps2/, /app/data/ps2-work/), and so does everything made from it.
# Built from the repository's root (docker-compose.yml): it uses server/ too (games.ts, discs.ts, and the builds' queue:
# queue.ts, fastjobs.ts). The same image runs on another machine (README "Workers em outra máquina").
FROM oven/bun:1.4 AS bun

FROM debian:trixie-slim
# clang (its vector builtins) with <format> (scripts/cxx.sh), cmake + ninja, python3, 7z for .7z images,
# curl + unzip for wgpu-native (scripts/fetch_wgpu.sh), git + xz for the Emscripten SDK.
RUN apt-get update \
  && apt-get install -y --no-install-recommends clang lld g++ cmake ninja-build python3 p7zip-full git \
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

WORKDIR /opt/hypeplay
COPY server/games.ts server/discs.ts server/queue.ts server/fastjobs.ts server/otlp.ts server/
COPY ps2-builder/builder.ts ps2-builder/jobs.ts ps2-builder/patch.ts ps2-builder/
# (RECOMP_COMMIT: a ready build made with another one is brought up to date)
ENV RECOMP=/opt/recomp DATA=/app/data EMSDK=/opt/recomp/tools/emsdk RECOMP_COMMIT=$RECOMP_COMMIT
CMD ["bun", "ps2-builder/builder.ts"]
