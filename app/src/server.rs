//! The HypePlay server (server/routes.ts): signing in, the library, the BIOS, a game's disc and its memory card.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Deserialize;

/// A request that didn't go through. `Expired`: the pass is no good anymore (403), sign in again.
#[derive(Debug)]
pub enum Fail {
    Expired,
    Msg(String),
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Fail::Expired => f.write_str("seu acesso venceu: entre de novo"),
            Fail::Msg(m) => f.write_str(m),
        }
    }
}

impl From<ureq::Error> for Fail {
    fn from(e: ureq::Error) -> Self {
        match e {
            ureq::Error::StatusCode(403) => Fail::Expired,
            ureq::Error::StatusCode(code) => Fail::Msg(format!("o servidor respondeu {code}")),
            e => Fail::Msg(format!("sem conexão com o servidor ({e})")),
        }
    }
}

impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Self {
        Fail::Msg(format!("erro no disco do PC ({e})"))
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The access pass (server/pass.ts): `<body>.<mac>`, the body base64url JSON with the person's Discord id, their name
/// and its expiry.
#[derive(Clone)]
pub struct Pass {
    pub token: String,
    pub id: String,
    pub name: String,
    pub exp: u64,
}

impl Pass {
    pub fn parse(token: &str) -> Option<Pass> {
        let token = token.trim();
        let (body, mac) = token.split_once('.')?;
        // (it goes in addresses as it is: only what the server's own encoding makes)
        if mac.is_empty() || mac.contains('.') || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) {
            return None;
        }
        #[derive(Deserialize)]
        struct Body {
            id: String,
            name: String,
            exp: f64,
        }
        let b: Body = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
        // (a Discord snowflake: it names this person's cards here)
        if b.id.is_empty() || b.id.len() > 20 || !b.id.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some(Pass { token: token.to_string(), id: b.id, name: b.name, exp: b.exp as u64 })
    }

    /// Good for a while yet: a game's save goes up when it closes, hours later, and a pass lasts 12 h.
    pub fn fresh(&self) -> bool {
        now_ms() + 3 * 3_600_000 < self.exp
    }
}

/// A game of the library (server/routes.ts ps2Entry).
#[derive(Deserialize, Clone)]
pub struct Game {
    pub key: String,
    pub id: String,
    pub name: String,
    pub cover: String,
    pub status: GameStatus,
}

#[derive(Deserialize, Clone)]
pub struct GameStatus {
    pub state: String,
}

/// A library game's id (server/library.ts ID: `slus-21678`, `slus-21678-2`), safe as a file name here.
pub fn good_id(id: &str) -> bool {
    let (letters, rest) = id.split_at(id.len().min(4));
    let mut parts = rest.strip_prefix('-').unwrap_or("").split('-');
    letters.len() == 4
        && letters.bytes().all(|b| b.is_ascii_lowercase())
        && parts.next().is_some_and(|d| d.len() == 5 && d.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none_or(|d| (1..=2).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}

pub struct Server {
    pub base: String,
    agent: ureq::Agent,
}

impl Server {
    pub fn new(base: &str) -> Server {
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .timeout_send_body(Some(Duration::from_secs(300)))
            .build()
            .into();
        Server { base: base.trim_end_matches('/').to_string(), agent }
    }

    pub fn agent(&self) -> &ureq::Agent {
        &self.agent
    }

    /// `p/<pass>/<rest>`: everything past signing in.
    pub fn url(&self, pass: &Pass, rest: &str) -> String {
        format!("{}/p/{}/{rest}", self.base, pass.token)
    }

    /// The PS2 games ready to play (their disc and the BIOS are on the server).
    pub fn games(&self, pass: &Pass) -> Result<Vec<Game>, Fail> {
        #[derive(Deserialize)]
        struct Catalog {
            games: Vec<Game>,
        }
        let mut res = self.agent.get(self.url(pass, "games")).call()?;
        let c: Catalog = serde_json::from_slice(&res.body_mut().read_to_vec()?).map_err(|e| Fail::Msg(format!("resposta estranha do servidor ({e})")))?;
        Ok(c.games.into_iter().filter(|g| g.key.starts_with("ps2/") && g.status.state == "ready" && good_id(&g.id)).collect())
    }

    /// A file of up to 10 MB (a cover, the BIOS), with its type.
    pub fn bytes(&self, pass: &Pass, rest: &str) -> Result<(Vec<u8>, String), Fail> {
        let mut res = self.agent.get(self.url(pass, rest)).call()?;
        let kind = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        Ok((res.body_mut().read_to_vec()?, kind))
    }

    /// The person's memory card for a game; None only when the server says there is none (404).
    pub fn card(&self, pass: &Pass, id: &str) -> Result<Option<Vec<u8>>, Fail> {
        match self.agent.get(self.url(pass, &format!("ps2/{id}/save"))).call() {
            Ok(mut res) => Ok(Some(res.body_mut().read_to_vec()?)),
            Err(ureq::Error::StatusCode(404)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn put_card(&self, pass: &Pass, id: &str, card: &[u8]) -> Result<(), Fail> {
        self.agent.put(self.url(pass, &format!("ps2/{id}/save"))).send(card)?;
        Ok(())
    }
}

/// Opens an address in the person's browser.
pub fn open_browser(url: &str) {
    #[cfg(windows)]
    let opened = Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(windows))]
    let opened = Command::new("xdg-open").arg(url).spawn();
    if let Err(e) = opened {
        eprintln!("hypeplay: abrir {url}: {e}");
    }
}

/// Signing in (routes.ts /login with port and nonce): Discord's page in the browser, then the pass back on this
/// machine's 127.0.0.1:<port>. `show` gets the address, to click or copy should the browser not come up.
pub fn sign_in(base: &str, show: impl FnOnce(&str), cancel: &AtomicBool) -> Result<Pass, String> {
    let fail = |e: std::io::Error| format!("Não deu para esperar a volta do Discord ({e})");
    let listener = TcpListener::bind("127.0.0.1:0").map_err(fail)?;
    listener.set_nonblocking(true).map_err(fail)?;
    let port = listener.local_addr().map_err(fail)?.port();
    let nonce = nonce();
    let url = format!("{}/login?port={port}&nonce={nonce}", base.trim_end_matches('/'));
    open_browser(&url);
    show(&url);
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Entrada cancelada.".into());
        }
        if Instant::now() > deadline {
            return Err("A entrada pelo Discord demorou demais. Tente de novo.".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(done) = answer(stream, &nonce) {
                    return done;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(fail(e)),
        }
    }
}

/// 128 bits nobody else can guess: RandomState's keys come from the system's randomness.
fn nonce() -> String {
    use std::hash::{BuildHasher, RandomState};
    (0..2).map(|i| format!("{:016x}", RandomState::new().hash_one((i, SystemTime::now())))).collect()
}

/// One request on the listener: the pass when it's the answer to ours (Err: cancelled on Discord's page), None for
/// anything else (the browser's icon, another tab).
fn answer(mut stream: TcpStream, nonce: &str) -> Option<Result<Pass, String>> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let got = parse_answer(&line, nonce);
    let text = match &got {
        Some(Ok(_)) => "Pronto! Pode fechar esta aba e voltar para o HypePlay.",
        Some(Err(_)) => "A entrada foi cancelada. Volte para o HypePlay para tentar de novo.",
        None => "HypePlay",
    };
    let page = format!(
        "<!doctype html><meta charset=utf-8><title>HypePlay</title><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b0a14;color:#f3f2fb;font:600 18px system-ui,sans-serif\"><p>{text}</p>"
    );
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
    got
}

/// The pass in `GET /?pass=…&nonce=… HTTP/1.1`, when the nonce is ours.
pub fn parse_answer(line: &str, nonce: &str) -> Option<Result<Pass, String>> {
    let query = line.strip_prefix("GET /?")?.split(' ').next()?;
    let (mut pass, mut ours) = (None, false);
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("pass", v)) => pass = Some(v),
            Some(("nonce", v)) => ours = v == nonce,
            _ => {}
        }
    }
    if !ours {
        return None;
    }
    Some(match pass {
        Some(p) => Pass::parse(p).ok_or_else(|| "O servidor mandou um passe estranho.".to_string()),
        None => Err("Entrada cancelada no Discord.".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass_for(name: &str, exp: u64) -> String {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"id":"42","name":"{name}","exp":{exp}}}"#));
        format!("{body}.mac-Of_it")
    }

    #[test]
    fn a_pass_says_whose_it_is_and_until_when() {
        let token = pass_for("Ana Maria", now_ms() + 12 * 3_600_000);
        let p = Pass::parse(&token).unwrap();
        assert_eq!((p.id.as_str(), p.name.as_str(), p.token.as_str()), ("42", "Ana Maria", token.as_str()));
        assert!(p.fresh());
        // (a game started now could outlast it: sign in again first)
        assert!(!Pass::parse(&pass_for("Ana", now_ms() + 3_600_000)).unwrap().fresh());
        for bad in ["", "abc", "abc.", "a.b.c", &format!("{token}/x"), "e30.mac"] {
            assert!(Pass::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_pass_comes_back_only_with_our_nonce() {
        let token = pass_for("Ana", now_ms() + 12 * 3_600_000);
        let ok = parse_answer(&format!("GET /?pass={token}&nonce=abc123 HTTP/1.1\r\n"), "abc123");
        assert_eq!(ok.unwrap().unwrap().token, token);
        // cancelled on Discord's page: back without a pass
        assert!(parse_answer("GET /?nonce=abc123 HTTP/1.1\r\n", "abc123").unwrap().is_err());
        // someone else's, or not an answer at all
        for line in [format!("GET /?pass={token}&nonce=other HTTP/1.1"), format!("GET /?pass={token} HTTP/1.1"), "GET /favicon.ico HTTP/1.1".into(), "POST /?nonce=abc123 HTTP/1.1".into()] {
            assert!(parse_answer(&line, "abc123").is_none(), "{line}");
        }
    }

    #[test]
    fn only_library_ids_name_files() {
        for id in ["slus-21678", "slus-21678-2", "scus-97399-12"] {
            assert!(good_id(id), "{id}");
        }
        for id in ["", "slus", "SLUS-21678", "slus-2167", "slus-21678-123", "slus-21678-", "../../x", "slus-21678/../x", "slu-216789"] {
            assert!(!good_id(id), "{id}");
        }
    }
}
