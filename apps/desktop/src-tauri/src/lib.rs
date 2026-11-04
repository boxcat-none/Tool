mod office;

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request};

/// 單一檔案轉換的逾時
const CONVERT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeStatus {
    /// 找到的 soffice 路徑；沒安裝時為 null
    soffice: Option<String>,
    extensions: &'static [&'static str],
}

#[tauri::command]
fn office_status() -> OfficeStatus {
    OfficeStatus {
        soffice: office::find_soffice().map(|p| p.to_string_lossy().into_owned()),
        extensions: office::SUPPORTED_EXTENSIONS,
    }
}

/// 拖放進來的檔案的暫存位置（瀏覽器的拖放拿不到原始路徑，只能先寫一份到暫存區）
fn drop_dir() -> PathBuf {
    std::env::temp_dir().join(format!("tool-drop-{}", std::process::id()))
}

/// 把一個 Office 檔案轉成 PDF，回傳輸出路徑。
/// 在背景執行緒執行，轉換期間介面不會卡住。
#[tauri::command]
async fn convert_office(input: String, out_dir: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let soffice = office::find_soffice().ok_or("找不到 LibreOffice，請先安裝。")?;
        let input = PathBuf::from(input);
        let out_dir = out_dir.map(PathBuf::from);
        let result = office::convert_to_pdf(&soffice, &input, out_dir.as_deref(), CONVERT_TIMEOUT)
            .map(|p| p.to_string_lossy().into_owned());
        // 暫存的拖放檔案轉換成功就刪掉；失敗時保留，讓使用者可以重試（程式關閉時會清掉）
        if result.is_ok() {
            if let Some(parent) = input.parent().filter(|p| p.starts_with(drop_dir())) {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
        result
    })
    .await
    .map_err(|e| format!("轉換程序異常結束：{e}"))?
}

/// 寫入檔案。內容以原始位元組傳送（不經過 JSON），路徑放在 x-path 標頭（URI 編碼）。
#[tauri::command]
fn save_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("缺少存檔路徑。")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("存檔內容格式錯誤。".into());
    };
    std::fs::write(&path, bytes).map_err(|e| format!("無法寫入「{path}」：{e}"))
}

/// 把拖放進來的檔案寫到暫存區，回傳暫存路徑。檔名放在 x-name 標頭（URI 編碼）。
#[tauri::command]
fn write_temp(request: Request<'_>) -> Result<String, String> {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("缺少檔名。")?;
    // 只取檔名，避免路徑跳脫到暫存區以外
    let name = PathBuf::from(&name)
        .file_name()
        .map(|n| n.to_owned())
        .ok_or("檔名不正確。")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("檔案內容格式錯誤。".into());
    };
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = drop_dir().join(n.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("無法建立暫存資料夾：{e}"))?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| format!("無法寫入暫存檔：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 在資料夾裡找一個不重複的檔名（批次存檔用）
#[tauri::command]
fn unique_file_path(dir: String, name: String) -> String {
    let name = PathBuf::from(name);
    let stem = name.file_stem().unwrap_or_default().to_string_lossy();
    let ext = name.extension().unwrap_or_default().to_string_lossy();
    office::unique_path(&PathBuf::from(dir), &stem, &ext)
        .to_string_lossy()
        .into_owned()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = |b: u8| (b as char).to_digit(16).unwrap() as u8;
            out.push(hex(bytes[i + 1]) * 16 + hex(bytes[i + 2]));
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            office_status,
            convert_office,
            save_file,
            write_temp,
            unique_file_path
        ])
        .build(tauri::generate_context!())
        .expect("無法啟動應用程式")
        .run(|_app, event| {
            // 關閉程式時清掉殘留的暫存檔
            if let tauri::RunEvent::Exit = event {
                let _ = std::fs::remove_dir_all(drop_dir());
                let _ = std::fs::remove_dir_all(
                    std::env::temp_dir().join(format!("tool-office-profile-{}", std::process::id())),
                );
            }
        });
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_uri_component() {
        assert_eq!(percent_decode("C%3A%5CUsers%5C%E5%A0%B1%E5%91%8A.pdf"), r"C:\Users\報告.pdf");
        assert_eq!(percent_decode("/tmp/a%20b.pdf"), "/tmp/a b.pdf");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%報"), "%報");
    }
}
