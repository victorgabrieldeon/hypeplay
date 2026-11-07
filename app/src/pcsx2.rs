//! PCSX2 2.8, packed beside the app by the Dockerfile (pcsx2/): its settings and a game in it. Everything of it lives
//! under `-datapath` (<data>/PCSX2/: inis, bios, memcards), apart from any PCSX2 the person has of their own.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

/// The server's BIOS, as PCSX2.ini's [Filenames] BIOS names it.
pub const BIOS: &str = "hypeplay.bin";

/// PCSX2's DualShock 2 bindings (PadDualshock2.cpp) on the first controller, as its own automatic mapping writes them
/// (SDLInputSource.cpp), for a [Pad1] with no controller bound yet: next to the keyboard's, which stay.
const PAD: &[(&str, &str)] = &[
    ("Up", "DPadUp"),
    ("Right", "DPadRight"),
    ("Down", "DPadDown"),
    ("Left", "DPadLeft"),
    ("Triangle", "FaceNorth"),
    ("Circle", "FaceEast"),
    ("Cross", "FaceSouth"),
    ("Square", "FaceWest"),
    ("Select", "Back"),
    ("Start", "Start"),
    ("L1", "LeftShoulder"),
    ("L2", "+LeftTrigger"),
    ("R1", "RightShoulder"),
    ("R2", "+RightTrigger"),
    ("L3", "LeftStick"),
    ("R3", "RightStick"),
    ("LUp", "-LeftY"),
    ("LRight", "+LeftX"),
    ("LDown", "+LeftY"),
    ("LLeft", "-LeftX"),
    ("RUp", "-RightY"),
    ("RRight", "+RightX"),
    ("RDown", "+RightY"),
    ("RLeft", "-RightX"),
    ("LargeMotor", "LargeMotor"),
    ("SmallMotor", "SmallMotor"),
];

pub struct Pcsx2 {
    pub exe: PathBuf,
    pub data: PathBuf,
}

impl Pcsx2 {
    /// Where the app's package put it.
    pub fn beside(app: &Path, data: PathBuf) -> Pcsx2 {
        let exe = if cfg!(windows) { app.join("pcsx2").join("pcsx2-qt.exe") } else { app.join("pcsx2").join("AppRun") };
        Pcsx2 { exe, data }
    }

    pub fn root(&self) -> PathBuf {
        self.data.join("PCSX2")
    }

    pub fn bios(&self) -> PathBuf {
        self.root().join("bios").join(BIOS)
    }

    pub fn memcards(&self) -> PathBuf {
        self.root().join("memcards")
    }

    fn command(&self) -> Command {
        let mut c = Command::new(&self.exe);
        c.arg("-datapath").arg(&self.data);
        c
    }

    /// PCSX2's settings with HypePlay's on top, for the game whose card is `card`. The first time PCSX2 writes its
    /// own defaults (-testconfig): keys, hotkeys (Esc: the pause menu), all of it.
    pub fn configure(&self, card: &str) -> Result<(), String> {
        let ini = self.root().join("inis").join("PCSX2.ini");
        if !ini.exists() {
            let made = self.command().arg("-testconfig").status().map_err(|e| format!("Não deu para abrir o PCSX2 ({e})"))?;
            if !made.success() || !ini.exists() {
                return Err(format!("O PCSX2 não criou as configurações dele ({made})"));
            }
        }
        let text = fs::read_to_string(&ini).map_err(|e| format!("Não deu para ler as configurações do PCSX2 ({e})"))?;
        fs::write(&ini, patch_ini(&text, card)).map_err(|e| format!("Não deu para gravar as configurações do PCSX2 ({e})"))
    }

    /// The game in full screen, without PCSX2's own window; back when it closes (its pause menu, Esc: Fechar o jogo).
    pub fn play(&self, disc: &Path) -> Result<ExitStatus, String> {
        self.command().args(["-batch", "-nogui", "-fullscreen", "--"]).arg(disc).status().map_err(|e| format!("Não deu para abrir o PCSX2 ({e})"))
    }
}

/// PCSX2.ini with what HypePlay needs and the rest as the person left it: no setup wizard, no "are you sure?" when
/// closing, the server's BIOS, the game's card alone in slot 1 (slot 2 off: a save there would never reach the server),
/// and the first controller bound when nothing is, its PS/Guide button opening the pause menu.
pub fn patch_ini(ini: &str, card: &str) -> String {
    let mut lines: Vec<String> = ini.trim_start_matches('\u{feff}').lines().map(str::to_string).collect();
    for (section, key, value) in [
        ("UI", "SetupWizardIncomplete", "false"),
        ("UI", "ConfirmShutdown", "false"),
        ("Filenames", "BIOS", BIOS),
        ("MemoryCards", "Slot1_Enable", "true"),
        ("MemoryCards", "Slot1_Filename", card),
        ("MemoryCards", "Slot2_Enable", "false"),
    ] {
        let (start, end) = section_of(&mut lines, section);
        match (start..end).find(|&i| key_of(&lines[i]).is_some_and(|k| k.eq_ignore_ascii_case(key))) {
            Some(i) => lines[i] = format!("{key} = {value}"),
            None => lines.insert(end, format!("{key} = {value}")),
        }
    }
    let (start, end) = section_of(&mut lines, "Pad1");
    if !lines[start..end].iter().any(|l| l.split_once('=').is_some_and(|(_, v)| v.trim().starts_with("SDL-"))) {
        let rest = lines.split_off(end);
        lines.extend(PAD.iter().map(|(key, input)| format!("{key} = SDL-0/{input}")));
        lines.extend(rest);
    }
    // (the pause menu, where the game closes, from the controller too: its PS/Guide button, next to Esc)
    let (start, end) = section_of(&mut lines, "Hotkeys");
    if !lines[start..end].iter().any(|l| key_of(l).is_some_and(|k| k.eq_ignore_ascii_case("OpenPauseMenu")) && l.contains("SDL-")) {
        lines.insert(end, "OpenPauseMenu = SDL-0/Guide".into());
    }
    lines.join("\n") + "\n"
}

fn key_of(line: &str) -> Option<&str> {
    let (key, _) = line.split_once('=')?;
    Some(key.trim()).filter(|k| !k.starts_with([';', '#']))
}

/// The lines of `[name]` (made at the end when missing): from its first key to just past its last one.
fn section_of(lines: &mut Vec<String>, name: &str) -> (usize, usize) {
    let header = format!("[{name}]");
    let start = match lines.iter().position(|l| l.trim().eq_ignore_ascii_case(&header)) {
        Some(i) => i + 1,
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(header);
            lines.len()
        }
    };
    let next = lines[start..].iter().position(|l| l.trim_start().starts_with('[')).map_or(lines.len(), |i| start + i);
    // (new keys go before the blank lines that set the next section apart)
    let end = (start..next).rev().find(|&i| !lines[i].trim().is_empty()).map_or(start, |i| i + 1);
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INI: &str = "\u{feff}[UI]\r\nSettingsVersion = 1\r\nSetupWizardIncomplete = true\r\nConfirmShutdown = true\r\n\r\n[Filenames]\r\nBIOS = \r\n\r\n[MemoryCards]\r\nSlot1_Enable = true\r\nSlot1_Filename = Mcd001.ps2\r\nSlot2_Enable = true\r\nSlot2_Filename = Mcd002.ps2\r\n\r\n[Pad1]\r\nType = DualShock2\r\nUp = Keyboard/Up\r\nCross = Keyboard/X\r\n\r\n[Hotkeys]\r\nOpenPauseMenu = Keyboard/Escape\r\n";

    fn values<'a>(ini: &'a str, section: &str, key: &str) -> Vec<&'a str> {
        let mut inside = false;
        let mut found = vec![];
        for line in ini.lines() {
            if line.starts_with('[') {
                inside = line == format!("[{section}]");
            } else if inside && let Some((k, v)) = line.split_once('=') && k.trim() == key {
                found.push(v.trim());
            }
        }
        found
    }

    #[test]
    fn our_settings_go_in_and_the_rest_stays() {
        let ini = patch_ini(INI, "slus-21678.ps2");
        assert_eq!(values(&ini, "UI", "SetupWizardIncomplete"), ["false"]);
        assert_eq!(values(&ini, "UI", "ConfirmShutdown"), ["false"]);
        assert_eq!(values(&ini, "UI", "SettingsVersion"), ["1"]);
        assert_eq!(values(&ini, "Filenames", "BIOS"), [BIOS]);
        assert_eq!(values(&ini, "MemoryCards", "Slot1_Filename"), ["slus-21678.ps2"]);
        assert_eq!(values(&ini, "MemoryCards", "Slot2_Enable"), ["false"]);
        assert_eq!(values(&ini, "MemoryCards", "Slot2_Filename"), ["Mcd002.ps2"]);
        assert_eq!(values(&ini, "Hotkeys", "OpenPauseMenu"), ["Keyboard/Escape", "SDL-0/Guide"]);
        // the controller next to the keyboard (PCSX2 reads repeated keys as a list)
        assert_eq!(values(&ini, "Pad1", "Cross"), ["Keyboard/X", "SDL-0/FaceSouth"]);
        assert_eq!(values(&ini, "Pad1", "L2"), ["SDL-0/+LeftTrigger"]);
        assert!(!ini.contains('\u{feff}') && !ini.contains('\r'));
    }

    #[test]
    fn again_changes_only_the_card_and_never_binds_the_controller_twice() {
        let once = patch_ini(INI, "slus-21678.ps2");
        assert_eq!(patch_ini(&once, "slus-21678.ps2"), once);
        let other = patch_ini(&once, "scus-97399.ps2");
        assert_eq!(values(&other, "MemoryCards", "Slot1_Filename"), ["scus-97399.ps2"]);
        assert_eq!(values(&other, "Pad1", "Cross"), ["Keyboard/X", "SDL-0/FaceSouth"]);
        // (a controller the person bound in PCSX2 stays theirs)
        let theirs = INI.replace("Cross = Keyboard/X", "Cross = SDL-1/FaceEast");
        assert_eq!(values(&patch_ini(&theirs, "x.ps2"), "Pad1", "Cross"), ["SDL-1/FaceEast"]);
    }

    #[test]
    fn missing_sections_are_made() {
        let ini = patch_ini("[UI]\nTheme = darker\n", "slus-21678.ps2");
        assert_eq!(values(&ini, "UI", "Theme"), ["darker"]);
        assert_eq!(values(&ini, "MemoryCards", "Slot1_Enable"), ["true"]);
        assert_eq!(values(&ini, "Filenames", "BIOS"), [BIOS]);
        assert_eq!(values(&ini, "Pad1", "Start"), ["SDL-0/Start"]);
    }
}
