use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{
    LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow,
};

pub const PANEL_WIDTH: f64 = 416.0;
pub const PANEL_HEIGHT: f64 = 756.0;

static ANIMATING: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);

struct Dock {
    shown: PhysicalPosition<i32>,
    hidden: PhysicalPosition<i32>,
}

fn dock_for(window: &WebviewWindow) -> Option<Dock> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();

    let width = (PANEL_WIDTH * scale).round() as i32;
    let height = (PANEL_HEIGHT * scale).round() as i32;
    let margin = (12.0 * scale).round() as i32;

    let work_y = work.position.y;
    let work_w = work.size.width as i32;
    let work_h = work.size.height as i32;
    let work_right = work.position.x + work_w;

    let y = if height + margin * 2 <= work_h {
        work_y + work_h - height - margin
    } else {
        work_y + (work_h - height).max(0)
    };

    let shown_x = work_right - width - margin;
    let hidden_x = work_right;

    Some(Dock {
        shown: PhysicalPosition::new(shown_x, y),
        hidden: PhysicalPosition::new(hidden_x, y),
    })
}

fn set_pos(window: &WebviewWindow, pos: PhysicalPosition<i32>) {
    let _ = window.set_position(Position::Physical(pos));
}

fn prepare_chrome(window: &WebviewWindow) {
    let _ = window.set_size(Size::Logical(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT)));
    let _ = window.set_background_color(Some((0x11, 0x13, 0x15, 255).into()));
    apply_round_clip(window);
}

/// Matches `--radius-card` so the native panel uses the same corner as list cards.
const CARD_CORNER_RADIUS: f64 = 18.0;

#[cfg(windows)]
fn apply_round_clip(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    let scale = window.scale_factor().unwrap_or(1.0);
    let radius = ((CARD_CORNER_RADIUS * scale).round() as i32).max(1);
    let ellipse = radius.saturating_mul(2);

    #[repr(C)]
    struct WinRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const u32, size: u32) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(hwnd: isize, rect: *mut WinRect) -> i32;
        fn SetWindowRgn(hwnd: isize, hrgn: isize, redraw: i32) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRoundRectRgn(x1: i32, y1: i32, x2: i32, y2: i32, w: i32, h: i32) -> isize;
    }

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DONOTROUND: u32 = 1;

    let mut rect = WinRect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        let width = (rect.right - rect.left).max(1);
        let height = (rect.bottom - rect.top).max(1);
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_DONOTROUND, 4);
        let region = CreateRoundRectRgn(0, 0, width, height, ellipse, ellipse);
        if region != 0 {
            SetWindowRgn(hwnd, region, 1);
        }
    }
}

#[cfg(not(windows))]
fn apply_round_clip(_window: &WebviewWindow) {}

fn animate(
    window: WebviewWindow,
    from: PhysicalPosition<i32>,
    to: PhysicalPosition<i32>,
    after: impl FnOnce(&WebviewWindow) + Send + 'static,
) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    ANIMATING.store(true, Ordering::SeqCst);
    thread::spawn(move || {
        let steps = 14u32;
        for i in 1..=steps {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let t = i as f64 / f64::from(steps);
            let eased = 1.0 - (1.0 - t).powi(3);
            let pos = PhysicalPosition::new(
                (from.x as f64 + (to.x as f64 - from.x as f64) * eased).round() as i32,
                (from.y as f64 + (to.y as f64 - from.y as f64) * eased).round() as i32,
            );
            let step_window = window.clone();
            let _ = window.run_on_main_thread(move || {
                set_pos(&step_window, pos);
            });
            thread::sleep(Duration::from_millis(16));
        }
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let finish_window = window.clone();
        let _ = window.run_on_main_thread(move || {
            set_pos(&finish_window, to);
            after(&finish_window);
            ANIMATING.store(false, Ordering::SeqCst);
        });
    });
}

pub fn webview(window: &tauri::Window) -> Option<WebviewWindow> {
    window.app_handle().get_webview_window(window.label())
}

pub fn show(window: &WebviewWindow) {
    prepare_chrome(window);
    let Some(dock) = dock_for(window) else {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    };
    set_pos(window, dock.hidden);
    let _ = window.set_skip_taskbar(false);
    let _ = window.unminimize();
    let _ = window.show();
    apply_round_clip(window);
    let _ = window.set_focus();
    animate(window.clone(), dock.hidden, dock.shown, |_| {});
}

pub fn hide(window: &WebviewWindow) {
    let Some(dock) = dock_for(window) else {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
        return;
    };
    let from = window.outer_position().unwrap_or(dock.shown);
    animate(window.clone(), from, dock.hidden, |hidden| {
        let _ = hidden.hide();
        let _ = hidden.set_skip_taskbar(true);
    });
}

pub fn snap(window: &WebviewWindow) {
    if ANIMATING.load(Ordering::SeqCst) {
        return;
    }
    let Some(dock) = dock_for(window) else {
        return;
    };
    let Ok(pos) = window.outer_position() else {
        return;
    };
    if (pos.x - dock.shown.x).abs() > 3 || (pos.y - dock.shown.y).abs() > 3 {
        set_pos(window, dock.shown);
    }
}
