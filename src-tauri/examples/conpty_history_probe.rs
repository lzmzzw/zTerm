// 仅本地固定输出探针：不读取用户数据、不运行模型、不连接服务器。
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

fn emit(fullscreen: bool) {
    let mut out = std::io::stdout();
    let mut write = |value: &str| {
        out.write_all(value.as_bytes()).unwrap();
        out.flush().unwrap();
        thread::sleep(Duration::from_millis(30));
    };
    write("\x1b[2J\x1b[H");
    for index in 0..35 {
        write(&format!("HISTORY-{index:03}\r\n"));
    }
    // 顶部 15 行为历史插入区，底部 5 行为临时 TUI。
    write("\x1b[16;1H\x1b[J");
    write("\x1b[18;1HWorking (0s)\x1b[20;1H> Ask a fixed question");
    for index in 0..12 {
        if fullscreen {
            write(&format!("\x1b[16;1H\x1b[JRESULT-{index:03}"));
            write("\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K");
            write(&format!(
                "\x1b[18;1H\x1b[2KWorking ({index}s)\x1b[20;1H> Ask a fixed question"
            ));
        } else {
            write(&format!(
                "\x1b[1;15r\x1b[15;1H\r\nRESULT-{index:03}\x1b[r\x1b[20;23H"
            ));
            // 类似 ratatui 的增量动画，仅更新计时文字，不重画未变的 Working。
            write(&format!("\x1b[18;10H{index}s)"));
        }
    }
    // grow_viewport: 把 composer 从 5 行增到 7 行，再完整重绘新区域。
    if fullscreen {
        write("\x1b[16;1H\x1b[J\x1b[20;1H\r\n\r\n");
    } else {
        write("\x1b[1;15r\x1b[2S\x1b[r");
    }
    write("\x1b[14;1H\x1b[J\x1b[16;1HWorking (12s)\x1b[20;1H> Ask a fixed question");
    write("\x1b[r\x1b[14;1H\x1b[JCOMPLETE\x1b[20;1H");
    for index in 0..25 {
        write(&format!("\r\nAFTER-{index:03}"));
    }
}

fn main() {
    let fullscreen = std::env::args().any(|arg| arg == "--fullscreen");
    if std::env::args().any(|arg| arg == "--emit") {
        emit(fullscreen);
        return;
    }
    let output = std::env::args().nth(1).expect("指定捕获 JSON 路径");
    let pair = native_pty_system()
        .openpty(PtySize {
            cols: 50,
            rows: 20,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(std::env::current_exe().unwrap());
    command.arg("--emit");
    if fullscreen {
        command.arg("--fullscreen");
    }
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    writer.write_all(b"\x1b[1;1R").unwrap();
    writer.flush().unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&bytes);
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            captured.lock().unwrap().extend_from_slice(&buffer[..count]);
        }
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("Synthetic child exceeded 15 seconds");
        }
        thread::sleep(Duration::from_millis(50));
    }
    thread::sleep(Duration::from_millis(250));
    drop(pair.master);
    let data = bytes.lock().unwrap().clone();
    std::fs::write(
        output,
        serde_json::to_vec_pretty(
            &serde_json::json!({ "cols": 50, "rows": 20, "data": String::from_utf8_lossy(&data) }),
        )
        .unwrap(),
    )
    .unwrap();
    println!("Captured {} synthetic bytes", data.len());
}
