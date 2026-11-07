//! HypePlay para PC: the PS2 games of a HypePlay server's library in PCSX2 on this PC, much faster than the browser's
//! WebAssembly. It signs in with Discord, lists the library, brings each game's disc here once, and takes the person's
//! memory card from the server and back. The package (Dockerfile) puts it beside PCSX2 (pcsx2/) and servidor.txt, the
//! server's address; all it keeps is in dados/ next to it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod card;
mod disc;
mod pcsx2;
mod server;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use eframe::egui::{self, Color32, CornerRadius, RichText, Stroke};

use card::Cards;
use disc::Progress;
use pcsx2::Pcsx2;
use server::{Fail, Game, Pass, Server};

// DESIGN.md's colors
const BG: Color32 = Color32::from_rgb(0x0b, 0x0a, 0x14);
const SURFACE: Color32 = Color32::from_rgb(0x13, 0x11, 0x1f);
const SURFACE_HI: Color32 = Color32::from_rgb(0x1b, 0x18, 0x30);
const SURFACE_TOP: Color32 = Color32::from_rgb(0x24, 0x20, 0x40);
const INK: Color32 = Color32::from_rgb(0xf3, 0xf2, 0xfb);
const SOFT: Color32 = Color32::from_rgb(0xa3, 0xa1, 0xbd);
const PRIMARY: Color32 = Color32::from_rgb(0x76, 0x55, 0xff);
const PRIMARY_HI: Color32 = Color32::from_rgb(0x6a, 0x4a, 0xf5);
const ACCENT: Color32 = Color32::from_rgb(0xa0, 0x8c, 0xff);
const DANGER: Color32 = Color32::from_rgb(0xf0, 0x38, 0x4c);

/// A PS2 BIOS (server/bios.ts checks it): 4 MiB.
const BIOS_BYTES: usize = 4 * 1024 * 1024;
/// What PCSX2 for Windows needs installed (its package doesn't bring it).
#[cfg(windows)]
const VC_REDIST: &str = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

/// What the app is doing: one thing at a time.
#[derive(Default, Clone)]
enum Busy {
    #[default]
    Idle,
    SigningIn { url: String },
    Loading,
    Preparing { name: String, what: &'static str },
    Getting { name: String, progress: Arc<Progress>, since: Instant },
    Playing { name: String },
    Saving { name: String },
}

#[derive(Default)]
struct Shared {
    pass: Option<Pass>,
    games: Vec<Game>,
    /// each game's cover by its address on the server: egui's uri for it, and its bytes
    covers: HashMap<String, (String, Arc<[u8]>)>,
    busy: Busy,
    /// a line for the person, and whether it's an error
    note: Option<(String, bool)>,
}

/// What the window and its jobs (threads) share.
struct Ctx {
    shared: Mutex<Shared>,
    ui: egui::Context,
    server: Server,
    /// dados/: the pass, the discs, the cards as the server has them, PCSX2's data
    data: PathBuf,
    pcsx2: Pcsx2,
    cards: Cards,
    /// stops signing in or a download
    cancel: AtomicBool,
}

impl Ctx {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, change: impl FnOnce(&mut Shared)) {
        change(&mut self.lock());
        self.ui.request_repaint();
    }

    fn busy(&self, busy: Busy) {
        self.set(|s| s.busy = busy);
    }

    fn note(&self, text: impl Into<String>, error: bool) {
        let text = text.into();
        self.set(|s| s.note = Some((text, error)));
    }

    fn pass_file(&self) -> PathBuf {
        self.data.join("passe.txt")
    }

    /// Back to signing in: the pass is no good anymore. A card that couldn't go up stays here, and goes after.
    fn expired(&self) {
        let _ = fs::remove_file(self.pass_file());
        self.set(|s| {
            s.pass = None;
            s.games.clear();
            s.busy = Busy::Idle;
            s.note = Some(("Seu acesso venceu: entre de novo com o Discord (um save que ficou aqui sobe logo depois).".into(), true));
        });
    }

    fn fail(&self, fail: Fail) {
        match fail {
            Fail::Expired => self.expired(),
            Fail::Msg(m) => {
                self.busy(Busy::Idle);
                self.note(first_upper(&m), true);
            }
        }
    }
}

fn first_upper(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

fn job(s: &Arc<Ctx>, run: impl FnOnce(&Ctx) + Send + 'static) {
    let s = s.clone();
    std::thread::spawn(move || run(&s));
}

fn sign_in(s: &Ctx) {
    s.cancel.store(false, Ordering::Relaxed);
    s.set(|sh| {
        sh.busy = Busy::SigningIn { url: String::new() };
        sh.note = None;
    });
    let got = server::sign_in(&s.server.base, |url| s.busy(Busy::SigningIn { url: url.to_string() }), &s.cancel);
    match got {
        Ok(pass) => {
            if let Err(e) = fs::create_dir_all(&s.data).and_then(|()| fs::write(s.pass_file(), &pass.token)) {
                s.note(format!("Não deu para guardar o acesso neste PC ({e}): vai pedir para entrar de novo."), true);
            }
            s.set(|sh| sh.pass = Some(pass));
            load(s);
        }
        Err(e) => {
            s.busy(Busy::Idle);
            s.note(e, true);
        }
    }
}

/// The library, then the covers and any card of this person's that didn't reach the server last time.
fn load(s: &Ctx) {
    let Some(pass) = s.lock().pass.clone() else { return };
    s.busy(Busy::Loading);
    let games = match s.server.games(&pass) {
        Ok(g) => g,
        Err(e) => return s.fail(e),
    };
    s.set(|sh| {
        sh.games = games.clone();
        sh.busy = Busy::Idle;
    });
    for g in &games {
        if s.lock().covers.contains_key(&g.cover) {
            continue;
        }
        if let Ok((bytes, kind)) = s.server.bytes(&pass, &g.cover) {
            // (egui's svg loader goes by the name's end; the other formats it reads from the bytes)
            let uri = format!("bytes://{}{}", g.cover.replace(|c: char| !c.is_ascii_alphanumeric(), "_"), if kind.contains("svg") { ".svg" } else { "" });
            s.set(|sh| {
                sh.covers.insert(g.cover.clone(), (uri, bytes.into()));
            });
        }
    }
    for g in &games {
        match s.cards.send(&s.server, &pass, &g.id) {
            Ok(true) => s.note(format!("O save de {} que tinha ficado neste PC subiu para o servidor.", g.name), false),
            Err(Fail::Expired) => return s.expired(),
            _ => {}
        }
    }
}

/// PCSX2 is where the package put it, with what it needs.
fn pcsx2_ready(s: &Ctx) -> Result<(), String> {
    if !s.pcsx2.exe.exists() {
        return Err(format!("O PCSX2 não está junto do app ({}). Baixe o app de novo pelo HypePlay.", s.pcsx2.exe.display()));
    }
    #[cfg(windows)]
    {
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32");
        if !["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"].iter().all(|dll| system.join(dll).exists()) {
            server::open_browser(VC_REDIST);
            return Err("O PCSX2 precisa do Visual C++ da Microsoft: instale o vc_redist.x64.exe que o navegador baixou e clique em Jogar de novo.".into());
        }
    }
    Ok(())
}

fn disc_of(data: &Path, id: &str) -> PathBuf {
    data.join("discos").join(format!("{id}.iso"))
}

fn play(s: &Ctx, g: Game) {
    let name = g.name.clone();
    let Some(pass) = s.lock().pass.clone().filter(Pass::fresh) else {
        return s.expired();
    };
    s.cancel.store(false, Ordering::Relaxed);
    if let Err(e) = pcsx2_ready(s) {
        return s.fail(Fail::Msg(e));
    }
    s.set(|sh| {
        sh.busy = Busy::Preparing { name: name.clone(), what: "Buscando a BIOS do servidor…" };
        sh.note = None;
    });
    if !s.pcsx2.bios().exists() {
        match s.server.bytes(&pass, "bios.bin") {
            Ok((bios, _)) if bios.len() == BIOS_BYTES => {
                if let Err(e) = card::write_whole(&s.pcsx2.bios(), &bios) {
                    return s.fail(e);
                }
            }
            Ok(_) => return s.fail(Fail::Msg("a BIOS do servidor não parece a de um PS2".into())),
            Err(e) => return s.fail(e),
        }
    }
    let disc = disc_of(&s.data, &g.id);
    if !disc.exists() {
        let progress = Arc::new(Progress::default());
        s.busy(Busy::Getting { name: name.clone(), progress: progress.clone(), since: Instant::now() });
        let url = s.server.url(&pass, &format!("ps2/{}/game/disc.iso", g.id));
        if let Err(e) = disc::fetch(s.server.agent(), &url, &disc, &progress, &s.cancel) {
            return s.fail(e);
        }
    }
    s.busy(Busy::Preparing { name: name.clone(), what: "Buscando o seu save…" });
    let late = match s.cards.prepare(&s.server, &pass, &g.id) {
        Ok(note) => note,
        Err(e) => return s.fail(e),
    };
    if let Err(e) = s.pcsx2.configure(&Cards::name(&pass, &g.id)) {
        return s.fail(Fail::Msg(e));
    }
    s.set(|sh| {
        sh.busy = Busy::Playing { name: name.clone() };
        sh.note = late.map(|n| (n, true));
    });
    let played = s.pcsx2.play(&disc);
    s.busy(Busy::Saving { name: name.clone() });
    let saved = save(s, &pass, &g.id);
    s.busy(Busy::Idle);
    match (played, saved) {
        (_, Err(Fail::Expired)) => s.expired(),
        (Err(e), _) => s.note(e, true),
        (Ok(status), _) if !status.success() => s.note(format!("O PCSX2 fechou com erro ({status})."), true),
        (_, Err(e)) => s.note(format!("O save não subiu agora ({e}): ele fica neste PC e sobe da próxima vez que abrir o app."), true),
        (_, Ok(true)) => s.note(format!("Save de {name} guardado no servidor."), false),
        (_, Ok(false)) => s.set(|sh| sh.note = None),
    }
}

/// The card up after a game, a few times over a couple of minutes when the server can't take it now.
fn save(s: &Ctx, pass: &Pass, id: &str) -> Result<bool, Fail> {
    let mut last = Fail::Msg(String::new());
    for wait in [0, 2, 5, 15, 30, 60] {
        std::thread::sleep(Duration::from_secs(wait));
        match s.cards.send(&s.server, pass, id) {
            Err(Fail::Msg(m)) => last = Fail::Msg(m),
            done => return done,
        }
    }
    Err(last)
}

struct App {
    s: Option<Arc<Ctx>>,
}

impl App {
    fn new(ui: egui::Context, here: &Path, base: Option<String>) -> App {
        let Some(base) = base else { return App { s: None } };
        let data = here.join("dados");
        let pcsx2 = Pcsx2::beside(here, data.clone());
        let cards = Cards { played: pcsx2.memcards(), synced: data.join("saves") };
        let s = Arc::new(Ctx { shared: Mutex::default(), ui, server: Server::new(&base), data, pcsx2, cards, cancel: AtomicBool::new(false) });
        let kept = fs::read_to_string(s.pass_file()).ok().and_then(|t| Pass::parse(&t));
        match kept {
            Some(pass) if pass.fresh() => {
                s.set(|sh| sh.pass = Some(pass));
                job(&s, load);
            }
            Some(_) => s.note("Entre de novo com o Discord: o acesso guardado venceu ou está para vencer.", false),
            None => {}
        }
        App { s: Some(s) }
    }
}

fn primary(text: &str) -> egui::Button<'_> {
    egui::Button::new(RichText::new(text).strong().color(Color32::WHITE)).fill(PRIMARY).min_size(egui::vec2(0.0, 36.0))
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

/// The download's line: how far, how fast, how long still.
fn progress_text(progress: &Progress, since: Instant) -> (f32, String) {
    let (done, total, resumed) = (progress.done.load(Ordering::Relaxed), progress.total.load(Ordering::Relaxed), progress.resumed.load(Ordering::Relaxed));
    if total == 0 {
        return (0.0, "Perguntando ao servidor o tamanho do disco…".into());
    }
    let speed = mb(done.saturating_sub(resumed)) / since.elapsed().as_secs_f64().max(0.5);
    let left = if speed > 0.05 { format!(" · falta ~{} min", (mb(total - done) / speed / 60.0).ceil() as u64) } else { String::new() };
    (done as f32 / total as f32, format!("{:.0} de {:.0} MB · {speed:.1} MB/s{left}", mb(done), mb(total)))
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let Some(s) = self.s.clone() else {
            egui::CentralPanel::default().show(ui, |ui| {
                ui.centered_and_justified(|ui| ui.label(RichText::new("Este app não sabe o endereço do servidor (falta o servidor.txt ao lado dele). Baixe o app de novo pelo HypePlay.").color(DANGER)));
            });
            return;
        };
        let (pass, busy, note, games, covers) = {
            let sh = s.lock();
            (sh.pass.clone(), sh.busy.clone(), sh.note.clone(), sh.games.clone(), sh.covers.clone())
        };
        let idle = matches!(busy, Busy::Idle);
        // (closing mid-game leaves PCSX2 open and its save for later: the game first. A save on its way can be cut, it
        // stays here and goes next time)
        if ui.ctx().input(|i| i.viewport().close_requested()) && matches!(busy, Busy::Playing { .. }) {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::CancelClose);
            s.note("O jogo ainda está aberto: feche ele primeiro (o save sobe quando ele fecha).", true);
        }

        egui::Panel::top("top").frame(egui::Frame::new().fill(SURFACE).inner_margin(egui::Margin::symmetric(20, 12))).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 0.0;
                ui.label(RichText::new("Hype").size(22.0).strong().color(INK));
                ui.label(RichText::new("Play").size(22.0).strong().color(ACCENT));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 12.0;
                    if let Some(p) = &pass {
                        if ui.add_enabled(idle, egui::Button::new("Sair")).clicked() {
                            let _ = fs::remove_file(s.pass_file());
                            s.set(|sh| {
                                sh.pass = None;
                                sh.games.clear();
                            });
                        }
                        if ui.add_enabled(idle, egui::Button::new("Atualizar")).clicked() {
                            s.busy(Busy::Loading);
                            job(&s, load);
                        }
                        ui.label(RichText::new(&p.name).color(SOFT));
                    }
                });
            });
        });

        if let Some((text, error)) = &note {
            egui::Panel::bottom("note").frame(egui::Frame::new().fill(SURFACE).inner_margin(egui::Margin::symmetric(20, 10))).show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new(text).color(if *error { DANGER } else { SOFT }));
                    if ui.small_button("OK").clicked() {
                        s.set(|sh| sh.note = None);
                    }
                });
            });
        }

        egui::CentralPanel::default().frame(egui::Frame::new().fill(BG).inner_margin(24)).show(ui, |ui| {
            if pass.is_none() {
                return signing_in(ui, &s, &busy);
            }
            status(ui, &s, &busy);
            if games.is_empty() && !matches!(busy, Busy::Loading) {
                ui.label(RichText::new("Nenhum jogo de PS2 pronto na biblioteca do servidor. Adicione um pelo HypePlay e clique em Atualizar.").color(SOFT));
            }
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = egui::vec2(20.0, 24.0);
                    for g in &games {
                        let here = disc_of(&s.data, &g.id).exists();
                        if game_card(ui, g, covers.get(&g.cover), here, idle) {
                            // (busy from the click itself: a second click can't start it twice)
                            s.busy(Busy::Preparing { name: g.name.clone(), what: "Preparando…" });
                            let g = g.clone();
                            job(&s, move |s| play(s, g));
                        }
                    }
                });
            });
        });
        if matches!(busy, Busy::Getting { .. }) {
            ui.ctx().request_repaint_after(Duration::from_millis(250));
        }
    }
}

fn signing_in(ui: &mut egui::Ui, s: &Arc<Ctx>, busy: &Busy) {
    ui.vertical_centered(|ui| {
        ui.add_space(ui.available_height() * 0.25);
        ui.heading(RichText::new("Os jogos de PS2 do HypePlay, direto no PC").size(26.0).strong().color(INK));
        ui.add_space(8.0);
        ui.label(RichText::new("No PCSX2, bem mais rápido que no navegador, com a mesma conta e os mesmos saves.").color(SOFT));
        ui.add_space(24.0);
        match busy {
            Busy::SigningIn { url } => {
                ui.label(RichText::new("Continue no navegador: entre com o Discord e volte aqui.").color(INK));
                if !url.is_empty() {
                    ui.add_space(8.0);
                    ui.label(RichText::new("Se ele não abriu, copie este link e cole no navegador:").color(SOFT));
                    let mut text = url.clone();
                    ui.add(egui::TextEdit::singleline(&mut text).desired_width(520.0));
                }
                ui.add_space(12.0);
                if ui.button("Cancelar").clicked() {
                    s.cancel.store(true, Ordering::Relaxed);
                }
            }
            _ => {
                if ui.add(primary("Entrar com o Discord")).clicked() {
                    s.busy(Busy::SigningIn { url: String::new() });
                    job(s, sign_in);
                }
            }
        }
    });
}

/// What's going on, above the library.
fn status(ui: &mut egui::Ui, s: &Arc<Ctx>, busy: &Busy) {
    let line = |ui: &mut egui::Ui, text: String| {
        ui.horizontal(|ui| {
            ui.spinner();
            ui.label(RichText::new(text).color(INK));
        });
    };
    match busy {
        Busy::Idle | Busy::SigningIn { .. } => return,
        Busy::Loading => line(ui, "Carregando a biblioteca…".into()),
        Busy::Preparing { name, what } => line(ui, format!("{name}: {what}")),
        Busy::Getting { name, progress, since } => {
            let (part, text) = progress_text(progress, *since);
            ui.label(RichText::new(format!("Baixando o disco de {name} (só da primeira vez)")).strong().color(INK));
            ui.horizontal(|ui| {
                ui.add(egui::ProgressBar::new(part).text(text).fill(PRIMARY).desired_width(ui.available_width() - 90.0));
                if ui.button("Parar").clicked() {
                    s.cancel.store(true, Ordering::Relaxed);
                }
            });
        }
        Busy::Playing { name } => {
            ui.label(RichText::new(format!("Jogando {name}")).strong().color(INK));
            ui.label(RichText::new("No jogo, Esc (ou o botão PS/Guide do controle) abre o menu do PCSX2: fechar o jogo volta para cá e o save sobe para o servidor.").color(SOFT));
        }
        Busy::Saving { name } => line(ui, format!("Guardando o save de {name} no servidor…")),
    }
    ui.add_space(16.0);
}

/// One game: its cover, its name and its button. True when it's clicked.
fn game_card(ui: &mut egui::Ui, g: &Game, cover: Option<&(String, Arc<[u8]>)>, here: bool, idle: bool) -> bool {
    const W: f32 = 168.0;
    ui.allocate_ui(egui::vec2(W, 340.0), |ui| {
        ui.vertical(|ui| {
            ui.set_width(W);
            let size = egui::vec2(W, W * 1.5);
            match cover {
                Some((uri, bytes)) => {
                    ui.add(egui::Image::from_bytes(uri.clone(), bytes.clone()).fit_to_exact_size(size).corner_radius(12));
                }
                None => {
                    let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
                    ui.painter().rect_filled(rect, 12, SURFACE_HI);
                }
            }
            ui.add(egui::Label::new(RichText::new(&g.name).strong().color(INK)).wrap());
            ui.add_enabled(idle, primary(if here { "Jogar" } else { "Baixar e jogar" })).clicked()
        })
        .inner
    })
    .inner
}

fn style(ctx: &egui::Context) {
    let mut v = egui::Visuals::dark();
    v.panel_fill = BG;
    v.window_fill = SURFACE;
    v.extreme_bg_color = SURFACE_HI;
    v.faint_bg_color = SURFACE;
    v.hyperlink_color = ACCENT;
    v.selection.bg_fill = PRIMARY;
    v.selection.stroke = Stroke::new(1.0, INK);
    for (w, fill) in [(&mut v.widgets.inactive, SURFACE_TOP), (&mut v.widgets.hovered, PRIMARY_HI), (&mut v.widgets.active, PRIMARY)] {
        w.weak_bg_fill = fill;
        w.bg_fill = fill;
        w.corner_radius = CornerRadius::same(8);
        w.fg_stroke = Stroke::new(1.0, INK);
    }
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, INK);
    ctx.set_visuals_of(egui::Theme::Dark, v);
    ctx.set_theme(egui::Theme::Dark);
    ctx.all_styles_mut(|style| {
        for (text, size) in [(egui::TextStyle::Body, 15.0), (egui::TextStyle::Button, 15.0), (egui::TextStyle::Heading, 22.0), (egui::TextStyle::Small, 12.0)] {
            if let Some(font) = style.text_styles.get_mut(&text) {
                font.size = size;
            }
        }
        style.spacing.button_padding = egui::vec2(14.0, 6.0);
    });
}

fn main() -> eframe::Result {
    let here = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."));
    // (HYPEPLAY_URL for trying it out against another server)
    let base = std::env::var("HYPEPLAY_URL")
        .ok()
        .or_else(|| fs::read_to_string(here.join("servidor.txt")).ok())
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"));
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("HypePlay").with_inner_size([1100.0, 720.0]).with_min_inner_size([560.0, 420.0]),
        ..Default::default()
    };
    eframe::run_native(
        "HypePlay",
        options,
        Box::new(move |cc| {
            egui_extras::install_image_loaders(&cc.egui_ctx);
            style(&cc.egui_ctx);
            Ok(Box::new(App::new(cc.egui_ctx.clone(), &here, base)))
        }),
    )
}
