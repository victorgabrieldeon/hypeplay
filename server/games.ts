/**
 * CordPlay's catalog: the games the server knows how to build from a disc image. Each one is a web port of a
 * decompiled game, compiled by its own builder service (builder/ for BT3) in its own data folder, <data>/<id>/.
 * The id is never taken from an address: routes look it up here.
 */
export interface Game {
  /** Its data folder's name (<data>/<id>/) and its place in the addresses (/p/<pass>/<id>/). */
  id: string;
  name: string;
  platform: string;
  year: number;
  tags: string[];
  blurb: string;
  /** Which disc image it takes, shown next to the upload. */
  disc: string;
  /** Accepted image sizes (bytes). */
  minIso: number;
  maxIso: number;
  /** Its builder's steps, by name (the builder only reports the current one). */
  steps: string[];
  /** The compiled game's files: nothing else from build/ is ever served. */
  files: Set<string>;
  /** Its cover: two colors for the gradient (no box art: nothing of the game ships with CordPlay). */
  colors: [string, string];
}

/** The PS2 games' builder steps (ps2-builder/), one per stage of the ps2-web-recomp's port.sh. */
export const PS2_STEPS = ["Lendo o disco", "Executável", "Traduzindo para C++", "Explorando o jogo", "Unidades vetoriais", "Compilando a página"];

export const GAMES: Game[] = [
  {
    id: "bt3",
    name: "Dragon Ball Z: Budokai Tenkaichi 3",
    platform: "PlayStation 2",
    year: 2007,
    tags: ["Luta", "Online", "2 jogadores"],
    blurb: "Mais de 160 lutadores em arenas 3D destrutíveis. Lute online com os amigos do canal ou contra a CPU.",
    disc: "Só a versão americana do jogo (SLUS-21678).",
    minIso: 1024 ** 3,
    maxIso: 9 * 1024 ** 3,
    steps: ["Conferindo a ISO", "Extraindo os dados", "Compilando o jogo", "Ajustando caminhos", "Publicando"],
    files: new Set([
      "index.html",
      "net.js",
      "net.css",
      "bt3-jspi.js",
      "bt3-jspi.wasm",
      "bt3-async.js",
      "bt3-async.wasm",
      "icon-180.png",
      "icon-192.png",
      "icon-512.png",
      "manifest.webmanifest",
    ]),
    colors: ["#f5a524", "#e2531f"],
  },
];
