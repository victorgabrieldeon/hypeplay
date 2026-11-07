//! A game's disc, brought whole to this PC before it plays (PCSX2 reads a file): in 16 MiB pieces, several at a time
//! (one connection to the server is slow from far away), each written only where it was asked for, and picked up
//! where it stopped when the download is cut short (`<disc>.part` and the list of its pieces, `<disc>.done`).

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use crate::server::Fail;

pub const PIECE: u64 = 16 << 20;
const WORKERS: usize = 6;
const TRIES: u64 = 4;

/// Bytes on this PC so far, of `total`; `resumed` of them were there before this download (for its speed).
#[derive(Default)]
pub struct Progress {
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub resumed: AtomicU64,
}

/// `bytes <first>-<last>/<total>`, a 206's Content-Range.
pub fn content_range(v: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = v.trim().strip_prefix("bytes ")?.split_once('/')?;
    let (first, last) = range.split_once('-')?;
    Some((first.parse().ok()?, last.parse().ok()?, total.parse().ok()?))
}

/// Piece `i` of a disc of `total` bytes: its first and last byte (the server clamps the last one, routes.ts).
pub fn piece(i: u64, total: u64) -> (u64, u64) {
    let first = i * PIECE;
    (first, (first + PIECE).min(total) - 1)
}

/// The pieces a `.done` list says are in the `.part` file: none when it was made for a disc of another size.
pub fn done_list(text: &str, total: u64) -> HashSet<u64> {
    let mut lines = text.lines();
    if lines.next().and_then(|l| l.trim().parse::<u64>().ok()) != Some(total) {
        return HashSet::new();
    }
    let pieces = total.div_ceil(PIECE);
    lines.filter_map(|l| l.trim().parse().ok()).filter(|&i| i < pieces).collect()
}

/// A piece is only written where it was asked for: a 200 (the whole disc) or another range would land elsewhere.
pub fn check(status: u16, range: Option<&str>, want: (u64, u64, u64)) -> Result<(), String> {
    if status != 206 {
        return Err(format!("o servidor não mandou a parte pedida do disco (HTTP {status})"));
    }
    if range.and_then(content_range) != Some(want) {
        return Err("o servidor mandou outra parte do disco".into());
    }
    Ok(())
}

fn beside(disc: &Path, ext: &str) -> PathBuf {
    let mut name = disc.as_os_str().to_owned();
    name.push(ext);
    PathBuf::from(name)
}

/// Brings `url` to `disc`, unless it's already there.
pub fn fetch(agent: &ureq::Agent, url: &str, disc: &Path, progress: &Progress, cancel: &AtomicBool) -> Result<(), Fail> {
    if disc.exists() {
        return Ok(());
    }
    let total = size(agent, url)?;
    let (part, list) = (beside(disc, ".part"), beside(disc, ".done"));
    let mut done = fs::read_to_string(&list).map(|t| done_list(&t, total)).unwrap_or_default();
    if done.is_empty() || !fs::metadata(&part).is_ok_and(|m| m.len() == total) {
        done.clear();
        if let Some(dir) = disc.parent() {
            fs::create_dir_all(dir)?;
        }
        File::create(&part)?.set_len(total)?;
        fs::write(&list, format!("{total}\n"))?;
    }
    let pieces = total.div_ceil(PIECE);
    let had = done.iter().map(|&i| piece(i, total).1 - piece(i, total).0 + 1).sum();
    progress.done.store(had, Ordering::Relaxed);
    progress.resumed.store(had, Ordering::Relaxed);
    progress.total.store(total, Ordering::Relaxed);

    let listed = Mutex::new(OpenOptions::new().append(true).open(&list)?);
    let next = AtomicU64::new(0);
    let failed: Mutex<Option<Fail>> = Mutex::new(None);
    let stop = || cancel.load(Ordering::Relaxed) || failed.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    std::thread::scope(|s| {
        for _ in 0..WORKERS {
            s.spawn(|| {
                while !stop() {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= pieces {
                        break;
                    }
                    if done.contains(&i) {
                        continue;
                    }
                    let got = get_piece(agent, url, &part, i, total, progress, cancel).and_then(|()| {
                        let mut f = listed.lock().unwrap_or_else(|e| e.into_inner());
                        writeln!(f, "{i}").map_err(Fail::from)
                    });
                    if let Err(e) = got {
                        failed.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(e);
                        break;
                    }
                }
            });
        }
    });
    if cancel.load(Ordering::Relaxed) {
        return Err(Fail::Msg("Download parado: ele continua de onde parou da próxima vez".into()));
    }
    if let Some(e) = failed.into_inner().unwrap_or_else(|e| e.into_inner()) {
        return Err(e);
    }
    // (every handle on the .part closed first: Windows won't rename an open file)
    drop(listed);
    fs::rename(&part, disc)?;
    let _ = fs::remove_file(&list);
    Ok(())
}

/// The disc's size, from the answer to its first byte.
fn size(agent: &ureq::Agent, url: &str) -> Result<u64, Fail> {
    let res = agent.get(url).header("Range", "bytes=0-0").call()?;
    let range = res.headers().get("content-range").and_then(|v| v.to_str().ok()).and_then(content_range);
    match range {
        Some((0, 0, total)) if res.status().as_u16() == 206 && total > 0 => Ok(total),
        _ => Err(Fail::Msg(format!("o servidor não mandou o disco em partes (HTTP {})", res.status().as_u16()))),
    }
}

fn get_piece(agent: &ureq::Agent, url: &str, part: &Path, i: u64, total: u64, progress: &Progress, cancel: &AtomicBool) -> Result<(), Fail> {
    let (first, last) = piece(i, total);
    let len = last - first + 1;
    let mut why = Fail::Msg(String::new());
    for attempt in 0..TRIES {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2 * attempt));
        }
        let mut wrote = 0;
        let got = (|| -> Result<(), Fail> {
            let res = agent.get(url).header("Range", format!("bytes={first}-{last}")).call()?;
            check(res.status().as_u16(), res.headers().get("content-range").and_then(|v| v.to_str().ok()), (first, last, total)).map_err(Fail::Msg)?;
            let mut f = OpenOptions::new().write(true).open(part)?;
            f.seek(SeekFrom::Start(first))?;
            let mut body = res.into_body().into_reader();
            let mut buf = vec![0; 256 << 10];
            while wrote < len {
                if cancel.load(Ordering::Relaxed) {
                    return Err(Fail::Msg("cancelado".into()));
                }
                let n = body.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                let n = (n as u64).min(len - wrote);
                f.write_all(&buf[..n as usize])?;
                wrote += n;
                progress.done.fetch_add(n, Ordering::Relaxed);
            }
            if wrote != len {
                return Err(Fail::Msg("a conexão caiu no meio de uma parte do disco".into()));
            }
            // (on the disk before the list says it's there)
            f.sync_data()?;
            Ok(())
        })();
        match got {
            Ok(()) => return Ok(()),
            Err(e) => {
                progress.done.fetch_sub(wrote, Ordering::Relaxed);
                // (a pass that expired won't get better by trying again)
                if matches!(e, Fail::Expired) || cancel.load(Ordering::Relaxed) {
                    return Err(e);
                }
                why = e;
            }
        }
    }
    Err(why)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_cover_the_disc_once_and_the_last_is_shorter() {
        let total = 2 * PIECE + 1234;
        assert_eq!(total.div_ceil(PIECE), 3);
        assert_eq!(piece(0, total), (0, PIECE - 1));
        assert_eq!(piece(1, total), (PIECE, 2 * PIECE - 1));
        assert_eq!(piece(2, total), (2 * PIECE, total - 1));
        assert_eq!(piece(0, 10), (0, 9));
    }

    #[test]
    fn a_piece_is_written_only_where_it_was_asked_for() {
        let want = (PIECE, 2 * PIECE - 1, 3 * PIECE);
        let header = format!("bytes {}-{}/{}", PIECE, 2 * PIECE - 1, 3 * PIECE);
        assert!(check(206, Some(&header), want).is_ok());
        // the whole disc (a range dropped on the way), no range, or another one: never written
        assert!(check(200, Some(&header), want).is_err());
        assert!(check(206, None, want).is_err());
        assert!(check(206, Some("bytes 0-16777215/50331648"), want).is_err());
        assert!(check(206, Some("bytes */50331648"), want).is_err());
        assert_eq!(content_range("bytes 0-0/4194304"), Some((0, 0, 4_194_304)));
        assert_eq!(content_range("bytes 0-0"), None);
    }

    #[test]
    fn a_cut_download_goes_on_with_the_pieces_it_has_only_for_the_same_disc() {
        let total = 3 * PIECE;
        assert_eq!(done_list(&format!("{total}\n0\n2\n"), total), HashSet::from([0, 2]));
        // (a half-written last line, or a piece past the end, isn't taken)
        assert_eq!(done_list(&format!("{total}\n1\n9\n2x"), total), HashSet::from([1]));
        // another disc's list: everything again
        assert!(done_list("123\n0\n1\n", total).is_empty());
        assert!(done_list("", total).is_empty());
    }
}
