//! 呼叫 LibreOffice 把 Word / Excel / PowerPoint 轉成 PDF。

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// 可以轉換的副檔名
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "doc", "docx", "odt", "rtf", // 文件
    "xls", "xlsx", "ods", "csv", // 試算表
    "ppt", "pptx", "odp", // 簡報
];

/// 尋找 LibreOffice 的 soffice 執行檔。
/// 順序：環境變數 TOOL_SOFFICE → 各作業系統的預設安裝位置 → PATH。
pub fn find_soffice() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("TOOL_SOFFICE").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(dir) = std::env::var_os(var) {
                candidates.push(PathBuf::from(dir).join("LibreOffice").join("program").join("soffice.exe"));
            }
        }
    } else if cfg!(target_os = "macos") {
        candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice".into());
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join("Applications/LibreOffice.app/Contents/MacOS/soffice"));
        }
    } else {
        candidates.push("/usr/bin/soffice".into());
        candidates.push("/usr/local/bin/soffice".into());
        candidates.push("/opt/libreoffice/program/soffice".into());
        candidates.push("/snap/bin/libreoffice".into());
    }
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found);
    }

    let names: &[&str] = if cfg!(target_os = "windows") {
        &["soffice.exe"]
    } else {
        &["soffice", "libreoffice"]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// 把一個檔案轉成 PDF，放到 `out_dir`（不指定時放在原檔旁邊），回傳輸出路徑。
/// 檔名重複時自動加上 (2)、(3)…，不會覆蓋既有檔案。
pub fn convert_to_pdf(
    soffice: &Path,
    input: &Path,
    out_dir: Option<&Path>,
    timeout: Duration,
) -> Result<PathBuf, String> {
    if !input.is_file() {
        return Err("找不到這個檔案。".into());
    }
    if !is_supported(input) {
        return Err("不支援這種檔案格式。".into());
    }
    let out_dir = match out_dir {
        Some(d) => d.to_path_buf(),
        None => input.parent().ok_or("無法判斷檔案所在的資料夾。")?.to_path_buf(),
    };
    if !out_dir.is_dir() {
        return Err("輸出資料夾不存在。".into());
    }

    // 每次轉換用獨立的暫存資料夾，轉好再搬到目的地，避免覆蓋同名檔案
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let work = std::env::temp_dir().join(format!("tool-office-{}-{}", std::process::id(), id));
    fs::create_dir_all(&work).map_err(|e| format!("無法建立暫存資料夾：{e}"))?;
    let result = run_soffice(soffice, input, &work, timeout).and_then(|pdf| {
        let stem = input.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let dest = unique_path(&out_dir, &stem, "pdf");
        move_file(&pdf, &dest).map_err(|e| format!("無法寫入輸出資料夾：{e}"))?;
        Ok(dest)
    });
    let _ = fs::remove_dir_all(&work);
    result
}

fn run_soffice(soffice: &Path, input: &Path, work: &Path, timeout: Duration) -> Result<PathBuf, String> {
    // 使用獨立的 LibreOffice 設定檔：使用者正開著 LibreOffice 時，
    // 共用設定檔會讓 headless 轉檔直接結束、什麼都沒產生。
    let profile = std::env::temp_dir().join(format!("tool-office-profile-{}", std::process::id()));
    let mut profile_arg = OsString::from("-env:UserInstallation=");
    profile_arg.push(file_url(&profile));

    let mut cmd = Command::new(soffice);
    cmd.arg("--headless")
        .arg("--norestore")
        .arg("--nolockcheck")
        .arg("--nodefault")
        .arg("--nologo")
        .arg(profile_arg)
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(work)
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("無法啟動 LibreOffice：{e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("轉換超過 {} 秒沒有完成，已停止。檔案可能太大或已損毀。", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(format!("LibreOffice 執行失敗：{e}")),
        }
    }

    // LibreOffice 失敗時常常仍回傳 0，所以以「有沒有產生 PDF」為準
    let pdf = fs::read_dir(work)
        .ok()
        .and_then(|entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")))
        });
    match pdf {
        Some(p) => Ok(p),
        None => {
            let mut stderr = String::new();
            if let Some(mut s) = child.stderr.take() {
                use std::io::Read;
                let _ = s.read_to_string(&mut stderr);
            }
            let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
            Err(if detail.is_empty() {
                "LibreOffice 無法轉換這個檔案，檔案可能已損毀或有密碼保護。".into()
            } else {
                format!("LibreOffice 無法轉換這個檔案（{detail}）")
            })
        }
    }
}

/// 在資料夾裡找一個不重複的檔名：報告.pdf → 報告 (2).pdf → 報告 (3).pdf
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|i| dir.join(format!("{stem} ({i}).{ext}")))
        .find(|p| !p.exists())
        .expect("unbounded range")
}

/// rename 不能跨磁碟，失敗時改用複製再刪除
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

/// 路徑轉成 LibreOffice 接受的 file:// URL（非 ASCII 與空白要百分比編碼）
pub fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') { "file://" } else { "file:///" });
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_encodes_spaces_and_unicode() {
        assert_eq!(file_url(Path::new("/tmp/a b/報告")), "file:///tmp/a%20b/%E5%A0%B1%E5%91%8A");
        assert_eq!(file_url(Path::new(r"C:\Users\me")), "file:///C:/Users/me");
    }

    #[test]
    fn supported_extensions_are_case_insensitive() {
        assert!(is_supported(Path::new("a.DOCX")));
        assert!(is_supported(Path::new("簡報.pptx")));
        assert!(!is_supported(Path::new("a.pdf")));
        assert!(!is_supported(Path::new("noext")));
    }

    #[test]
    fn unique_path_skips_existing() {
        let dir = std::env::temp_dir().join(format!("tool-unique-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_path(&dir, "報告", "pdf"), dir.join("報告.pdf"));
        fs::write(dir.join("報告.pdf"), b"").unwrap();
        fs::write(dir.join("報告 (2).pdf"), b"").unwrap();
        assert_eq!(unique_path(&dir, "報告", "pdf"), dir.join("報告 (3).pdf"));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 需要電腦上有 LibreOffice；沒有的話跳過。
    #[test]
    fn converts_real_documents() {
        let Some(soffice) = find_soffice() else {
            eprintln!("找不到 LibreOffice，略過");
            return;
        };
        let dir = std::env::temp_dir().join(format!("tool-convert-{} 中文", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // CSV 與 RTF 都是純文字，可以直接產生測試檔
        let csv = dir.join("試算表.csv");
        fs::write(&csv, "品項,數量\n蘋果,3\n").unwrap();
        let rtf = dir.join("文件 一.rtf");
        fs::write(&rtf, r"{\rtf1\ansi Hello PDF\par}").unwrap();

        for input in [&csv, &rtf] {
            let out = convert_to_pdf(&soffice, input, None, Duration::from_secs(120)).unwrap();
            assert_eq!(out.parent().unwrap(), dir);
            assert_eq!(out.extension().unwrap(), "pdf");
            let bytes = fs::read(&out).unwrap();
            assert!(bytes.starts_with(b"%PDF"), "{out:?} 不是 PDF");
        }
        // 再轉一次同一個檔案，不能覆蓋前一次的結果
        let again = convert_to_pdf(&soffice, &csv, None, Duration::from_secs(120)).unwrap();
        assert_eq!(again.file_name().unwrap(), "試算表 (2).pdf");

        // 不支援的格式、不存在的檔案
        assert!(convert_to_pdf(&soffice, &dir.join("x.pdf"), None, Duration::from_secs(5)).is_err());
        let fake = dir.join("壞掉.docx");
        fs::write(&fake, b"this is not a docx").unwrap();
        let err = convert_to_pdf(&soffice, &fake, None, Duration::from_secs(120));
        // LibreOffice 有時會把壞掉的 docx 當純文字轉出來，兩種結果都可以接受，但不能 panic
        eprintln!("壞掉.docx → {err:?}");

        fs::remove_dir_all(&dir).unwrap();
    }
}
