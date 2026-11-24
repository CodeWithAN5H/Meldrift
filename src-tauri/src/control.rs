//! Remote-control input injection.
//!
//! The host's game runs on this machine. A granted controller sends keyboard
//! and mouse events over a WebRTC data channel; the React layer validates the
//! grant and forwards a small batch here, where Windows `SendInput` injects it.
//!
//! Deliberate limits:
//!   - No hooks are installed into games, no code is injected, no memory is
//!     touched, and no anti-cheat/DRM check is bypassed.
//!   - `SendInput` is system-wide. Meldrift therefore *arms* one target window,
//!     forces it to the foreground before a grant, and watches it. If the
//!     window closes, is minimised, or loses focus, input stops immediately and
//!     every held key/button is released. The target is never described as a
//!     sandbox; the guarantee is focus-based, backed by the watchdog.
//!   - Injection is refused unless the host explicitly armed a target and the
//!     frontend still holds an active, server-issued grant.
//!
//! Every failure path calls `release_all`, so a remote player cannot leave a key
//! physically stuck down on the host's keyboard.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTarget {
    pub id: String,
    pub title: String,
    pub process: String,
    pub minimized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedTarget {
    pub id: String,
    pub title: String,
    pub process: String,
    /// True when the window lost focus; keys are released and injection is
    /// refused until the host explicitly resumes.
    pub paused: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    #[serde(default)]
    pub scan: u32,
    /// The virtual-key code lets Windows translate the key into a character for
    /// ordinary applications. Games still see the physical scan code.
    #[serde(default)]
    pub vk: u32,
    #[serde(default)]
    pub extended: bool,
    #[serde(default)]
    pub down: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveInput {
    #[serde(default)]
    pub dx: i32,
    #[serde(default)]
    pub dy: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonInput {
    #[serde(default)]
    pub button: u8,
    #[serde(default)]
    pub down: bool,
}

/// A small, bounded batch. The controller coalesces mouse movement before it
/// gets here; the limits stop a malicious client from making one huge call.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputBatch {
    #[serde(default)]
    pub keys: Vec<KeyInput>,
    #[serde(default)]
    pub moves: Vec<MoveInput>,
    #[serde(default)]
    pub buttons: Vec<ButtonInput>,
    #[serde(default)]
    pub wheel: i32,
}

pub const MAX_KEYS_PER_BATCH: usize = 24;
pub const MAX_MOVES_PER_BATCH: usize = 64;
pub const MAX_BUTTONS_PER_BATCH: usize = 12;
pub const MAX_MOVE_DELTA: i32 = 4_000;
pub const MAX_WHEEL_DELTA: i32 = 6_000;

/// Pure validation shared by Windows and the non-Windows stub, so the protocol
/// rules are testable everywhere.
pub fn validate_batch(batch: &InputBatch) -> Result<(), String> {
    if batch.keys.len() > MAX_KEYS_PER_BATCH {
        return Err("Too many key events in one input batch".into());
    }
    if batch.moves.len() > MAX_MOVES_PER_BATCH {
        return Err("Too many mouse moves in one input batch".into());
    }
    if batch.buttons.len() > MAX_BUTTONS_PER_BATCH {
        return Err("Too many mouse button events in one input batch".into());
    }
    for key in &batch.keys {
        // Set 1 scan codes are one byte. Extended keys carry the 0xE0 prefix,
        // which is expressed with the extended flag, not a wider number.
        if key.scan == 0 || key.scan > 0xFF {
            return Err("Unknown keyboard scan code".into());
        }
        if key.vk == 0 || key.vk > 0xFF {
            return Err("Unknown virtual key".into());
        }
    }
    for movement in &batch.moves {
        if movement.dx.abs() > MAX_MOVE_DELTA || movement.dy.abs() > MAX_MOVE_DELTA {
            return Err("Mouse movement is out of range".into());
        }
    }
    for button in &batch.buttons {
        if !(1..=3).contains(&button.button) {
            return Err("Unknown mouse button".into());
        }
    }
    if batch.wheel.abs() > MAX_WHEEL_DELTA {
        return Err("Mouse wheel delta is out of range".into());
    }
    Ok(())
}

pub fn init(app: &tauri::AppHandle) {
    platform::init(app);
}

pub fn shutdown() {
    platform::shutdown();
}

#[tauri::command]
pub fn control_targets() -> Result<Vec<ControlTarget>, String> {
    platform::targets()
}

#[tauri::command]
pub fn control_arm(app: tauri::AppHandle, id: String) -> Result<ArmedTarget, String> {
    platform::arm(&app, &id)
}

#[tauri::command]
pub fn control_end() -> Result<(), String> {
    platform::end();
    Ok(())
}

#[tauri::command]
pub fn control_inject(batch: InputBatch) -> Result<(), String> {
    validate_batch(&batch)?;
    platform::inject(&batch)
}

#[tauri::command]
pub fn control_armed() -> Result<Option<ArmedTarget>, String> {
    Ok(platform::armed())
}

#[tauri::command]
pub fn control_resume() -> Result<ArmedTarget, String> {
    platform::resume()
}

#[cfg(windows)]
mod platform {
    use super::{ArmedTarget, ControlTarget, InputBatch};
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use tauri::Emitter;

    type Hwnd = isize;

    const INPUT_MOUSE: u32 = 0;
    const INPUT_KEYBOARD: u32 = 1;

    const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
    const KEYEVENTF_KEYUP: u32 = 0x0002;

    const MOUSEEVENTF_MOVE: u32 = 0x0001;
    const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
    const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
    const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
    const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
    const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
    const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
    const MOUSEEVENTF_WHEEL: u32 = 0x0800;

    const SW_RESTORE: i32 = 9;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const DWMWA_CLOAKED: u32 = 14;

    const MOD_ALT: u32 = 0x0001;
    const MOD_CONTROL: u32 = 0x0002;
    const MOD_NOREPEAT: u32 = 0x4000;
    const VK_F12: u32 = 0x7B;
    const WM_HOTKEY: u32 = 0x0312;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyboardInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct HardwareInput {
        msg: u32,
        param_l: u16,
        param_h: u16,
    }

    #[repr(C)]
    union InputUnion {
        mi: MouseInput,
        ki: KeyboardInput,
        hi: HardwareInput,
    }

    #[repr(C)]
    struct Input {
        kind: u32,
        data: InputUnion,
    }

    #[repr(C)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        point_x: i32,
        point_y: i32,
        private: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
        fn EnumWindows(
            callback: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>,
            param: isize,
        ) -> i32;
        fn GetWindowTextW(hwnd: Hwnd, buffer: *mut u16, max: i32) -> i32;
        fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn RegisterHotKey(hwnd: Hwnd, id: i32, modifiers: u32, key: u32) -> i32;
        #[allow(dead_code)] // only the ignored native input test moves the cursor.
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn PeekMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32, remove: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn QueryFullProcessImageNameW(
            process: isize,
            flags: u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(
            hwnd: Hwnd,
            attribute: u32,
            value: *mut c_void,
            size: u32,
        ) -> i32;
    }

    #[derive(Debug)]
    struct Armed {
        hwnd: Hwnd,
        title: String,
        process: String,
        generation: u64,
        paused: bool,
    }

    #[derive(Default)]
    struct Held {
        /// scan code → (virtual key, extended)
        keys: HashMap<u16, (u16, bool)>,
        buttons: HashSet<u8>,
    }

    #[derive(Default)]
    struct State {
        armed: Option<Armed>,
        held: Held,
        generation: u64,
    }

    /// `Mutex::new(State::default())` is not const-friendly, so the state is
    /// created on first use and never torn down.
    fn state() -> &'static Mutex<State> {
        static STATE: OnceLock<Mutex<State>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(State::default()))
    }

    fn app_handle() -> &'static Mutex<Option<tauri::AppHandle>> {
        static APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
        APP.get_or_init(|| Mutex::new(None))
    }

    pub fn init(app: &tauri::AppHandle) {
        if let Ok(mut slot) = app_handle().lock() {
            *slot = Some(app.clone());
        }
        let handle = app.clone();
        // A global hotkey is the emergency stop that works while the game owns
        // the keyboard. It does not capture or inspect any keystrokes.
        std::thread::spawn(move || unsafe {
            if RegisterHotKey(0, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_F12) == 0 {
                eprintln!("[meldrift] Ctrl+Alt+F12 could not be registered for emergency stop");
                return;
            }
            let mut message: Msg = std::mem::zeroed();
            loop {
                let result = PeekMessageW(&mut message, 0, 0, 0, 0);
                if result == 0 {
                    std::thread::sleep(Duration::from_millis(40));
                    continue;
                }
                if message.message == WM_HOTKEY {
                    emergency(&handle);
                } else {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        });
    }

    fn emit(app: &tauri::AppHandle, event: &str, payload: &str) {
        let _ = app.emit(event, payload.to_string());
    }

    fn emergency(app: &tauri::AppHandle) {
        let released = {
            let mut guard = match state().lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            release_all(&mut guard);
            guard.armed = None;
            guard.generation += 1;
            true
        };
        if released {
            emit(app, "control://emergency", "Emergency stop: control released.");
        }
    }

    pub fn shutdown() {
        let mut guard = match state().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        release_all(&mut guard);
        guard.armed = None;
        guard.generation += 1;
    }

    fn title_of(hwnd: Hwnd) -> String {
        unsafe {
            let length = GetWindowTextLengthW(hwnd);
            if length <= 0 {
                return String::new();
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let written = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if written <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buffer[..written as usize])
        }
    }

    fn process_of(hwnd: Hwnd) -> String {
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return String::new();
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return String::new();
            }
            let mut buffer = vec![0u16; 1_024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string()
        }
    }

    fn is_cloaked(hwnd: Hwnd) -> bool {
        unsafe {
            let mut cloaked: u32 = 0;
            let result = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            );
            result == 0 && cloaked != 0
        }
    }

    unsafe extern "system" fn collect(hwnd: Hwnd, param: isize) -> i32 {
        let list = &mut *(param as *mut Vec<ControlTarget>);
        if IsWindowVisible(hwnd) == 0 || is_cloaked(hwnd) {
            return 1;
        }
        let title = title_of(hwnd);
        if title.trim().is_empty() || title == "Program Manager" {
            return 1;
        }
        let process = process_of(hwnd);
        if process.eq_ignore_ascii_case("meldrift.exe") {
            return 1;
        }
        list.push(ControlTarget {
            id: hwnd.to_string(),
            title,
            process,
            minimized: IsIconic(hwnd) != 0,
        });
        1
    }

    pub fn targets() -> Result<Vec<ControlTarget>, String> {
        let mut list: Vec<ControlTarget> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut list as *mut Vec<ControlTarget> as isize);
        }
        list.sort_by(|a, b| a.process.to_lowercase().cmp(&b.process.to_lowercase()).then(a.title.cmp(&b.title)));
        Ok(list)
    }

    fn foreground_is(hwnd: Hwnd) -> bool {
        unsafe { GetForegroundWindow() == hwnd }
    }

    fn check_target(hwnd: Hwnd) -> Result<(), String> {
        unsafe {
            if IsWindow(hwnd) == 0 {
                return Err("The game window closed.".into());
            }
            if IsIconic(hwnd) != 0 {
                return Err("The game window was minimised.".into());
            }
            if !foreground_is(hwnd) {
                return Err("The game window is no longer in the foreground.".into());
            }
        }
        Ok(())
    }

    pub fn arm(app: &tauri::AppHandle, id: &str) -> Result<ArmedTarget, String> {
        let target = arm_window(id)?;
        let hwnd: Hwnd = target
            .id
            .parse()
            .map_err(|_| "That window is not available.".to_string())?;
        let generation = {
            let guard = match state().lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            guard.armed.as_ref().map(|armed| armed.generation).unwrap_or(0)
        };
        watch(app.clone(), hwnd, generation);
        Ok(target)
    }

    /// Arms without the Tauri watchdog; used by the native verification test.
    fn arm_window(id: &str) -> Result<ArmedTarget, String> {
        let hwnd: Hwnd = id
            .trim()
            .parse()
            .map_err(|_| "That window is not available.".to_string())?;
        unsafe {
            if IsWindow(hwnd) == 0 {
                return Err("That window is no longer open.".into());
            }
            let title = title_of(hwnd);
            if title.trim().is_empty() || is_cloaked(hwnd) {
                return Err("That window cannot be focused. Pick another window.".into());
            }
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if !foreground_is(hwnd) {
                SetForegroundWindow(hwnd);
                std::thread::sleep(Duration::from_millis(150));
            }
            if !foreground_is(hwnd) {
                return Err(
                    "Windows did not let Meldrift focus that window. Click the game first, then arm it again."
                        .into(),
                );
            }

            let process = process_of(hwnd);
            {
                let mut guard = match state().lock() {
                    Ok(guard) => guard,
                    Err(poison) => poison.into_inner(),
                };
                release_all(&mut guard);
                guard.generation += 1;
                guard.armed = Some(Armed {
                    hwnd,
                    title: title.clone(),
                    process: process.clone(),
                    generation: guard.generation,
                    paused: false,
                });
            }

            Ok(ArmedTarget {
                id: hwnd.to_string(),
                title,
                process,
                paused: false,
            })
        }
    }

    pub fn armed() -> Option<ArmedTarget> {
        let guard = match state().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        guard.armed.as_ref().map(|armed| ArmedTarget {
            id: armed.hwnd.to_string(),
            title: armed.title.clone(),
            process: armed.process.clone(),
            paused: armed.paused,
        })
    }

    /// Losing focus pauses injection and releases held keys. Closing or
    /// minimising the window disarms it and invalidates the grant.
    fn watch(app: tauri::AppHandle, hwnd: Hwnd, generation: u64) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(400));
            let paused = {
                let guard = match state().lock() {
                    Ok(guard) => guard,
                    Err(poison) => poison.into_inner(),
                };
                match &guard.armed {
                    Some(armed) if armed.generation == generation => armed.paused,
                    _ => return,
                }
            };
            if paused {
                continue;
            }
            if unsafe { IsWindow(hwnd) == 0 || IsIconic(hwnd) != 0 } {
                let closed = unsafe { IsWindow(hwnd) == 0 };
                let current = {
                    let mut guard = match state().lock() {
                        Ok(guard) => guard,
                        Err(poison) => poison.into_inner(),
                    };
                    let current = guard
                        .armed
                        .as_ref()
                        .map(|armed| armed.generation == generation)
                        .unwrap_or(false);
                    if current {
                        release_all(&mut guard);
                        guard.armed = None;
                        guard.generation += 1;
                    }
                    current
                };
                if current {
                    emit(
                        &app,
                        "control://invalidated",
                        if closed {
                            "The game window closed."
                        } else {
                            "The game window was minimised."
                        },
                    );
                }
                return;
            }
            if !foreground_is(hwnd) {
                let paused_now = {
                    let mut guard = match state().lock() {
                        Ok(guard) => guard,
                        Err(poison) => poison.into_inner(),
                    };
                    let current = matches!(
                        &guard.armed,
                        Some(armed) if armed.generation == generation && !armed.paused
                    );
                    if current {
                        release_all(&mut guard);
                        if let Some(armed) = guard.armed.as_mut() {
                            armed.paused = true;
                        }
                    }
                    current
                };
                if paused_now {
                    emit(
                        &app,
                        "control://paused",
                        "The game lost focus, so input paused and held keys were released.",
                    );
                }
            }
        });
    }

    pub fn resume() -> Result<ArmedTarget, String> {
        let hwnd = {
            let guard = match state().lock() {
                Ok(guard) => guard,
                Err(poison) => poison.into_inner(),
            };
            match &guard.armed {
                Some(armed) => armed.hwnd,
                None => return Err("No control target is armed.".into()),
            }
        };
        if unsafe { IsWindow(hwnd) == 0 || IsIconic(hwnd) != 0 } {
            return Err("The game window is no longer available.".into());
        }
        if !foreground_is(hwnd) {
            unsafe {
                SetForegroundWindow(hwnd);
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if !foreground_is(hwnd) {
            return Err(
                "Windows did not let Meldrift focus the game. Click the game, then resume."
                    .into(),
            );
        }
        let mut guard = match state().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        match guard.armed.as_mut() {
            Some(armed) => {
                armed.paused = false;
                Ok(ArmedTarget {
                    id: armed.hwnd.to_string(),
                    title: armed.title.clone(),
                    process: armed.process.clone(),
                    paused: false,
                })
            }
            None => Err("No control target is armed.".into()),
        }
    }

    fn key_input(scan: u16, vk: u16, extended: bool, down: bool) -> Input {
        // Both codes: the scan code is what games and raw-input APIs read, the
        // virtual key is what TranslateMessage needs to produce a character.
        let mut flags = 0;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        Input {
            kind: INPUT_KEYBOARD,
            data: InputUnion {
                ki: KeyboardInput {
                    vk,
                    scan,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        }
    }

    fn mouse_input(dx: i32, dy: i32, data: u32, flags: u32) -> Input {
        Input {
            kind: INPUT_MOUSE,
            data: InputUnion {
                mi: MouseInput {
                    dx,
                    dy,
                    mouse_data: data,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        }
    }

    unsafe fn dispatch(inputs: &[Input]) -> Result<(), String> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<Input>() as i32,
        );
        if sent != inputs.len() as u32 {
            return Err(
                "Windows rejected the input. If the game runs as administrator, Meldrift must run at the same level."
                    .into(),
            );
        }
        Ok(())
    }

    /// Releases every key/button Meldrift pressed. Runs on revoke, target loss,
    /// emergency stop, stream stop, sign-out and application shutdown.
    fn release_all(state: &mut State) {
        let mut inputs: Vec<Input> = Vec::new();
        for (scan, (vk, extended)) in state.held.keys.drain() {
            inputs.push(key_input(scan, vk, extended, false));
        }
        for button in state.held.buttons.drain() {
            let flags = match button {
                1 => MOUSEEVENTF_LEFTUP,
                2 => MOUSEEVENTF_RIGHTUP,
                3 => MOUSEEVENTF_MIDDLEUP,
                _ => continue,
            };
            inputs.push(mouse_input(0, 0, 0, flags));
        }
        unsafe {
            let _ = dispatch(&inputs);
        }
    }

    pub fn end() {
        let mut guard = match state().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        release_all(&mut guard);
        guard.armed = None;
        guard.generation += 1;
    }

    pub fn inject(batch: &InputBatch) -> Result<(), String> {
        if !foreground_is_armed() {
            // Checked before locking so a focus change in the tiny window
            // between check and SendInput is still caught by the watchdog.
            return Err("The game window is not focused, so input was not sent.".into());
        }

        let mut guard = match state().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        let hwnd = match &guard.armed {
            Some(armed) if !armed.paused => armed.hwnd,
            Some(_) => return Err("Remote input is paused until the host resumes.".into()),
            None => return Err("No control target is armed.".into()),
        };
        check_target(hwnd)?;

        let mut inputs: Vec<Input> = Vec::new();
        for movement in &batch.moves {
            if movement.dx != 0 || movement.dy != 0 {
                inputs.push(mouse_input(
                    movement.dx,
                    movement.dy,
                    0,
                    MOUSEEVENTF_MOVE,
                ));
            }
        }
        for button in &batch.buttons {
            let flags = match (button.button, button.down) {
                (1, true) => MOUSEEVENTF_LEFTDOWN,
                (1, false) => MOUSEEVENTF_LEFTUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                (2, false) => MOUSEEVENTF_RIGHTUP,
                (3, true) => MOUSEEVENTF_MIDDLEDOWN,
                (3, false) => MOUSEEVENTF_MIDDLEUP,
                _ => continue,
            };
            inputs.push(mouse_input(0, 0, 0, flags));
            if button.down {
                guard.held.buttons.insert(button.button);
            } else {
                guard.held.buttons.remove(&button.button);
            }
        }
        if batch.wheel != 0 {
            inputs.push(mouse_input(
                0,
                0,
                batch.wheel as u32,
                MOUSEEVENTF_WHEEL,
            ));
        }
        for key in &batch.keys {
            inputs.push(key_input(
                key.scan as u16,
                key.vk as u16,
                key.extended,
                key.down,
            ));
            if key.down {
                guard
                    .held
                    .keys
                    .insert(key.scan as u16, (key.vk as u16, key.extended));
            } else {
                guard.held.keys.remove(&(key.scan as u16));
            }
        }

        unsafe { dispatch(&inputs) }
    }

    fn foreground_is_armed() -> bool {
        let guard = match state().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        match &guard.armed {
            Some(armed) => foreground_is(armed.hwnd),
            None => false,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rejects_unknown_or_oversized_input() {
            let mut batch = InputBatch::default();
            batch.keys.push(super::super::KeyInput {
                scan: 0,
                vk: 0x41,
                extended: false,
                down: true,
            });
            assert!(super::super::validate_batch(&batch).is_err());

            let batch = InputBatch {
                moves: vec![super::super::MoveInput { dx: 9_000, dy: 1 }],
                ..Default::default()
            };
            assert!(super::super::validate_batch(&batch).is_err());

            let batch = InputBatch {
                buttons: vec![super::super::ButtonInput { button: 9, down: true }],
                ..Default::default()
            };
            assert!(super::super::validate_batch(&batch).is_err());
        }

        /// Real `SendInput` verification against an application that logs what
        /// it receives. Ignored by default because it opens a window and moves
        /// the real cursor; run it explicitly on an interactive desktop.
        #[test]
        #[ignore = "opens a real window and injects OS-level input"]
        fn injects_keyboard_and_mouse_into_a_real_window() {
            use std::process::{Command, Stdio};

            let dir = std::env::temp_dir().join("meldrift-m5-input-check");
            std::fs::create_dir_all(&dir).expect("temp dir");
            let log = dir.join("events.log");
            let script = dir.join("target.ps1");
            let _ = std::fs::remove_file(&log);

            std::fs::write(
                &script,
                r#"param($LogPath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Meldrift Input Target'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(0, 0)
$form.Width = 1100
$form.Height = 800
$tb = New-Object System.Windows.Forms.TextBox
$tb.Dock = 'Top'
$tb.Font = New-Object System.Drawing.Font('Consolas', 20)
$form.Controls.Add($tb)
$tb.Add_KeyDown({ param($s, $e) Add-Content -Path $LogPath -Value "keydown:$($e.KeyCode)" })
$tb.Add_KeyUp({ param($s, $e) Add-Content -Path $LogPath -Value "keyup:$($e.KeyCode)" })
$tb.Add_TextChanged({ $codes = ($tb.Text.ToCharArray() | ForEach-Object { [int]$_ }) -join ','; [System.IO.File]::AppendAllText($LogPath, "text:$($tb.Text) codes:$codes" + [Environment]::NewLine, [System.Text.Encoding]::UTF8) })
$form.Add_MouseMove({ param($s, $e) Add-Content -Path $LogPath -Value "mousemove:$($e.X),$($e.Y)" })
$form.Add_MouseDown({ param($s, $e) Add-Content -Path $LogPath -Value "mousedown:$($e.Button)" })
$form.Add_MouseWheel({ param($s, $e) Add-Content -Path $LogPath -Value "wheel:$($e.Delta)" })
$form.Add_Shown({ $form.Activate(); $tb.Focus() })
Add-Content -Path $LogPath -Value "ready layout=$([System.Windows.Forms.InputLanguage]::CurrentInputLanguage.Culture.Name) culture=$((Get-Culture).Name)"
[System.Windows.Forms.Application]::Run($form)
"#,
            )
            .expect("script");

            let mut child = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-STA",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    script.to_str().unwrap(),
                    log.to_str().unwrap(),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("start target app");

            let hwnd = (0..60)
                .find_map(|_| {
                    std::thread::sleep(Duration::from_millis(150));
                    targets().ok().and_then(|list| {
                        list.into_iter()
                            .find(|target| target.title.contains("Meldrift Input Target"))
                            .map(|target| target.id)
                    })
                })
                .expect("target window did not appear");

            let armed = arm_window(&hwnd).expect("arm target");
            assert!(armed.title.contains("Meldrift Input Target"));
            std::thread::sleep(Duration::from_millis(250));

            // Put the pointer inside the test window so clicks/wheel land on it.
            let point = [560i32, 400i32];
            unsafe {
                SetCursorPos(point[0], point[1]);
            }
            std::thread::sleep(Duration::from_millis(150));

            // "meldrift" in set-1 scan codes.
            for (scan, vk) in [
                (0x32u32, 0x4Du32),
                (0x12, 0x45),
                (0x26, 0x4C),
                (0x20, 0x44),
                (0x13, 0x52),
                (0x17, 0x49),
                (0x21, 0x46),
                (0x14, 0x54),
            ] {
                inject(&InputBatch {
                    keys: vec![super::super::KeyInput {
                        scan,
                        vk,
                        extended: false,
                        down: true,
                    }],
                    ..Default::default()
                })
                .expect("key down");
                std::thread::sleep(Duration::from_millis(15));
                inject(&InputBatch {
                    keys: vec![super::super::KeyInput {
                        scan,
                        vk,
                        extended: false,
                        down: false,
                    }],
                    ..Default::default()
                })
                .expect("key up");
                std::thread::sleep(Duration::from_millis(15));
            }

            inject(&InputBatch {
                moves: vec![super::super::MoveInput { dx: 30, dy: 10 }],
                ..Default::default()
            })
            .expect("move");
            inject(&InputBatch {
                buttons: vec![super::super::ButtonInput {
                    button: 1,
                    down: true,
                }],
                ..Default::default()
            })
            .expect("click down");
            inject(&InputBatch {
                buttons: vec![super::super::ButtonInput {
                    button: 1,
                    down: false,
                }],
                ..Default::default()
            })
            .expect("click up");
            inject(&InputBatch {
                wheel: 120,
                ..Default::default()
            })
            .expect("wheel");

            std::thread::sleep(Duration::from_millis(700));
            end();
            let _ = child.kill();
            let _ = child.wait();

            let events = std::fs::read_to_string(&log).unwrap_or_default();
            eprintln!("target log:\n{events}");
            // The target PC's keyboard layout decides which characters these
            // physical keys produce, so verify the received key count and the
            // translated text rather than assuming a US layout.
            assert!(
                events.matches("keydown:").count() >= 8,
                "keyboard presses missing: {events}"
            );
            assert!(
                events.matches("keyup:").count() >= 8,
                "key releases missing: {events}"
            );
            assert!(
                events.lines().any(|line| line.contains("codes:")
                    && line
                        .split("codes:")
                        .nth(1)
                        .map(|codes| codes.split(',').count() >= 8)
                        .unwrap_or(false)),
                "translated text missing: {events}"
            );
            assert!(events.contains("mousedown:Left"), "mouse click missing: {events}");
            assert!(events.contains("mousemove:"), "mouse movement missing: {events}");
            assert!(events.contains("wheel:120"), "wheel missing: {events}");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{ArmedTarget, ControlTarget, InputBatch};

    pub fn init(_app: &tauri::AppHandle) {}
    pub fn shutdown() {}

    pub fn targets() -> Result<Vec<ControlTarget>, String> {
        Err("Remote control is Windows-only in this build.".into())
    }

    pub fn arm(_app: &tauri::AppHandle, _id: &str) -> Result<ArmedTarget, String> {
        Err("Remote control is Windows-only in this build.".into())
    }

    pub fn armed() -> Option<ArmedTarget> {
        None
    }

    pub fn resume() -> Result<ArmedTarget, String> {
        Err("Remote control is Windows-only in this build.".into())
    }

    pub fn end() {}

    pub fn inject(_batch: &InputBatch) -> Result<(), String> {
        Err("Remote control is Windows-only in this build.".into())
    }
}
