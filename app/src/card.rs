//! A game's memory card between this PC and the server: the same card the browser plays (server/saves.ts), with the
//! rules of page/cardsync.ts, as the server's copy is the person's save and must never be overwritten by mistake.
//!
//! - PCSX2 plays `memcards/<person>-<game>.ps2` (the person's Discord id: whoever signs in on this PC keeps their own);
//!   `saves/<person>-<game>.ps2` is that card as the server last had it.
//! - A card PCSX2 changed that never reached the server (the app closed first, the upload failed) goes up before
//!   anything else, and stays the card: it's the newest.
//! - Otherwise the server's comes down, or none when it says there is none (404): PCSX2 makes a blank one. Any other
//!   answer means no game, as a stale or blank card played now would go up over the real one.
//! - After a game, the card goes up when it changed and is formatted (the server takes nothing else).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::server::{Fail, Pass, Server};

/// An 8 MB card with its ECC, PCSX2's file layout (saves.ts CARD_BYTES).
pub const CARD_BYTES: usize = 8_650_752;
const MAGIC: &[u8] = b"Sony PS2 Memory Card Format ";

pub fn formatted(card: &[u8]) -> bool {
    card.len() == CARD_BYTES && card.starts_with(MAGIC)
}

/// A card the server hasn't got yet.
pub fn unsent(card: Option<&[u8]>, synced: Option<&[u8]>) -> bool {
    card.is_some_and(|c| formatted(c) && synced != Some(c))
}

/// The file's bytes; None only when there's no file.
fn read(path: &Path) -> Result<Option<Vec<u8>>, Fail> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Whole or not at all: a write cut short never leaves half a card.
pub fn write_whole(path: &Path, bytes: &[u8]) -> Result<(), Fail> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn remove(path: &Path) -> Result<(), Fail> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

pub struct Cards {
    /// PCSX2's memory card folder
    pub played: PathBuf,
    /// the cards as the server last had them
    pub synced: PathBuf,
}

impl Cards {
    /// The card PCSX2 plays for a person's game (PCSX2.ini's Slot1_Filename).
    pub fn name(pass: &Pass, id: &str) -> String {
        format!("{}-{id}.ps2", pass.id)
    }

    fn paths(&self, pass: &Pass, id: &str) -> (PathBuf, PathBuf) {
        let name = Cards::name(pass, id);
        (self.played.join(&name), self.synced.join(&name))
    }

    /// Sends the card if the server hasn't got it yet: true when it went up.
    pub fn send(&self, srv: &Server, pass: &Pass, id: &str) -> Result<bool, Fail> {
        let (card, synced) = self.paths(pass, id);
        let bytes = read(&card)?;
        if !unsent(bytes.as_deref(), read(&synced)?.as_deref()) {
            return Ok(false);
        }
        let bytes = bytes.unwrap_or_default();
        srv.put_card(pass, id, &bytes)?;
        write_whole(&synced, &bytes)?;
        Ok(true)
    }

    /// Before a game: the card in place for PCSX2, and a note when a save from before couldn't go up yet.
    pub fn prepare(&self, srv: &Server, pass: &Pass, id: &str) -> Result<Option<String>, Fail> {
        let (card, synced) = self.paths(pass, id);
        if unsent(read(&card)?.as_deref(), read(&synced)?.as_deref()) {
            return match self.send(srv, pass, id) {
                Ok(_) => Ok(None),
                Err(Fail::Expired) => Err(Fail::Expired),
                Err(e) => Ok(Some(format!("O save da última vez ainda não subiu ({e}): ele vai quando o jogo fechar."))),
            };
        }
        match srv.card(pass, id)? {
            Some(bytes) if bytes.len() == CARD_BYTES => {
                write_whole(&card, &bytes)?;
                write_whole(&synced, &bytes)?;
            }
            Some(_) => return Err(Fail::Msg("o save no servidor não parece um memory card".into())),
            None => {
                remove(&card)?;
                remove(&synced)?;
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(fill: u8) -> Vec<u8> {
        let mut c = vec![fill; CARD_BYTES];
        c[..MAGIC.len()].copy_from_slice(MAGIC);
        c
    }

    #[test]
    fn only_a_formatted_card_that_changed_goes_up() {
        let (a, b) = (card(1), card(2));
        assert!(unsent(Some(&a), None));
        assert!(unsent(Some(&b), Some(&a)));
        assert!(!unsent(Some(&a), Some(&a)));
        assert!(!unsent(None, Some(&a)));
        // PCSX2's blank card (0xff, unformatted) and anything of another size: the server takes neither
        assert!(!unsent(Some(&vec![0xff; CARD_BYTES]), None));
        assert!(!unsent(Some(&a[..CARD_BYTES - 1]), None));
    }

    #[test]
    fn a_card_is_written_whole_over_the_old_one() {
        let dir = std::env::temp_dir().join(format!("hypeplay-card-{}", std::process::id()));
        let path = dir.join("slus-21678.ps2");
        write_whole(&path, b"old").unwrap();
        write_whole(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!dir.join("slus-21678.ps2.tmp").exists());
        assert_eq!(read(&dir.join("none.ps2")).unwrap(), None);
        remove(&path).unwrap();
        remove(&path).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
