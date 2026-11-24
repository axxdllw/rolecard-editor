// release 版不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rolecard_editor_lib::run()
}
