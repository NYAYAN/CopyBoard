// Windows'ta konsol penceresi açılmasın (release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    copyboard_lib::run()
}
