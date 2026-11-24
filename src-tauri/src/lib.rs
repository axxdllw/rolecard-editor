#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // AI 请求走原生 HTTP，绕开中转站的跨域限制
        .plugin(tauri_plugin_http::init())
        // 导出文件时弹“另存为”并写盘
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 外部链接用系统浏览器打开
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("启动角色卡编辑器失败");
}
