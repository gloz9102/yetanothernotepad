mod document;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    document::run();
}
