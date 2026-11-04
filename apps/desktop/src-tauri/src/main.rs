// Windows release 版不要多開一個命令列視窗
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tool_desktop_lib::run()
}
