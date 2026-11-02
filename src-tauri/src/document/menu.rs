use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle,
};

use super::types::{DocumentResult, MenuContextUpdate};

pub(super) fn install_menu(app: &AppHandle, context: &MenuContextUpdate) -> DocumentResult<()> {
    let korean = context.locale == "ko";
    let label = |ko: &'static str, en: &'static str| if korean { ko } else { en };
    let item = |id: &'static str,
                text: &'static str,
                accelerator: Option<&'static str>,
                enabled: bool|
     -> Result<_, tauri::Error> {
        let mut builder = MenuItemBuilder::with_id(id, text).enabled(enabled);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };
    let check_item = |id: &'static str,
                      text: &'static str,
                      accelerator: Option<&'static str>,
                      enabled: bool,
                      checked: bool|
     -> Result<_, tauri::Error> {
        let mut builder = CheckMenuItemBuilder::with_id(id, text)
            .enabled(enabled)
            .checked(checked);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };

    let new_text = item(
        "new-text",
        label("새 텍스트", "New Text"),
        Some("CmdOrCtrl+N"),
        true,
    )?;
    let new_markdown = item(
        "new-markdown",
        label("새 Markdown", "New Markdown"),
        Some("CmdOrCtrl+Shift+N"),
        true,
    )?;
    let open = item("open", label("열기…", "Open…"), Some("CmdOrCtrl+O"), true)?;
    let save = item(
        "save",
        label("저장", "Save"),
        Some("CmdOrCtrl+S"),
        context.has_document,
    )?;
    let save_as = item(
        "save-as",
        label("다른 이름으로 저장…", "Save As…"),
        Some("CmdOrCtrl+Shift+S"),
        context.has_document,
    )?;
    let close = item(
        "close",
        label("탭 닫기", "Close Tab"),
        Some("CmdOrCtrl+W"),
        context.has_document,
    )?;
    let file = SubmenuBuilder::new(app, label("파일", "File"))
        .items(&[&new_text, &new_markdown, &open])
        .separator()
        .items(&[&save, &save_as])
        .separator()
        .item(&close)
        .build()?;

    let undo = item(
        "undo",
        label("실행 취소", "Undo"),
        Some("CmdOrCtrl+Z"),
        context.has_document,
    )?;
    let redo = item(
        "redo",
        label("다시 실행", "Redo"),
        Some("CmdOrCtrl+Shift+Z"),
        context.has_document,
    )?;
    let find = item(
        "find",
        label("찾기", "Find"),
        Some("CmdOrCtrl+F"),
        context.has_document,
    )?;
    let replace = item(
        "replace",
        label("찾기 및 바꾸기", "Find and Replace"),
        Some("CmdOrCtrl+H"),
        context.has_document,
    )?;
    let edit = SubmenuBuilder::new(app, label("편집", "Edit"))
        .items(&[&undo, &redo])
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .items(&[&find, &replace])
        .build()?;

    let source = check_item(
        "view-source",
        label("원문", "Source"),
        Some("CmdOrCtrl+Alt+1"),
        context.has_document,
        context.view_mode == "source",
    )?;
    let split = check_item(
        "view-split",
        label("분할", "Split"),
        Some("CmdOrCtrl+Alt+2"),
        context.markdown,
        context.view_mode == "split",
    )?;
    let preview = check_item(
        "view-preview",
        label("리치뷰", "Rich View"),
        Some("CmdOrCtrl+Alt+3"),
        context.markdown,
        context.view_mode == "preview",
    )?;
    let settings = item(
        "settings",
        label("설정…", "Settings…"),
        Some("CmdOrCtrl+,"),
        true,
    )?;
    let view = SubmenuBuilder::new(app, label("보기", "View"))
        .items(&[&source, &split, &preview])
        .separator()
        .item(&settings)
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, "Yet Another Notepad")
            .about(None)
            .separator()
            .item(
                &MenuItemBuilder::with_id("quit", label("종료", "Quit"))
                    .accelerator("Cmd+Q")
                    .build(app)?,
            )
            .build()?;
        MenuBuilder::new(app)
            .items(&[&app_menu, &file, &edit, &view])
            .build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}
