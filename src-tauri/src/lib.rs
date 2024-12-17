use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use std::thread;
use std::fs;
use std::env;
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings},
};
use std::sync::Mutex;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::Foundation::POINT;
use std::collections::VecDeque;
use serde::{Serialize, Deserialize};
use rdev::{listen, EventType};
use tauri::{Manager, Emitter};
use std::io::Read;
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
use std::mem::zeroed;

// Global static variables that can be safely accessed from multiple threads
static RECORDING: AtomicBool = AtomicBool::new(false);  // Tracks if we're currently recording
static mut VIDEO_PATH: Option<String> = None;  // Stores the path where video will be saved
static SHOULD_STOP: AtomicBool = AtomicBool::new(false);  // Signals when to stop recording
static IS_MOUSE_CLICKED: AtomicBool = AtomicBool::new(false);
static SHOULD_LISTEN_CLICKS: AtomicBool = AtomicBool::new(false);

// Add these new structures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MousePosition {
    x: i32,
    y: i32,
    timestamp: f64,
    isClicked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    id: String,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_primary: bool,
}

// Add this global static for storing mouse positions
lazy_static::lazy_static! {
    static ref MOUSE_POSITIONS: Mutex<VecDeque<MousePosition>> = Mutex::new(VecDeque::new());
}

// Main struct that handles the screen capture process
struct CaptureHandler {
    encoder: Option<VideoEncoder>,  // Handles video encoding, wrapped in Option to allow taking ownership later
    start: Instant,  // Tracks when recording started
    last_mouse_capture: Instant,
}

// Implementation of the GraphicsCaptureApiHandler trait for our CaptureHandler
// This defines how our handler will interact with the Windows screen capture API
impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = String;  // Type used for passing configuration flags
    type Error = Box<dyn std::error::Error + Send + Sync>;  // Type used for error handling

    // Called when creating a new capture session
    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        println!("Created capture handler with flags: {}", ctx.flags);

        // Get primary monitor dimensions
        let monitor = Monitor::primary()?;
        let width = monitor.width()?;
        let height = monitor.height()?;
        println!("Recording at resolution: {}x{}", width, height);

        // Create temporary file path for the video
        let temp_dir = env::temp_dir();
        let video_path = temp_dir.join("screen_recording.mp4");
        
        unsafe {
            VIDEO_PATH = Some(video_path.to_string_lossy().to_string());
        }

        // Configure video encoding settings with actual monitor dimensions
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(width, height)  // Use actual dimensions
                .frame_rate(30)
                .bitrate(5_000_000),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &video_path,
        )?;

        Ok(Self {
            encoder: Some(encoder),
            start: Instant::now(),
            last_mouse_capture: Instant::now(),
        })
    }

    // Called every time a new frame is captured
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let current_time = self.start.elapsed();
        
        // Use thread_local for last frame time to avoid unsafe blocks
        thread_local! {
            static LAST_FRAME_TIME: std::cell::RefCell<Option<Instant>> = std::cell::RefCell::new(None);
        }
        
        // Calculate frame delta more safely
        let frame_delta = LAST_FRAME_TIME.with(|last| {
            let mut last = last.borrow_mut();
            let now = Instant::now();
            let delta = match *last {
                Some(prev) => {
                    if now > prev {
                        now.duration_since(prev)
                    } else {
                        std::time::Duration::from_millis(16) // Default to 60fps timing if calculation fails
                    }
                },
                None => std::time::Duration::from_millis(16)
            };
            *last = Some(now);
            delta
        });

        // Log frame timing during fast changes (when frames are coming in quickly)
        if frame_delta.as_millis() < 20 {
            static mut FRAME_COUNT: u32 = 0;
            static mut LAST_LOG_TIME: Option<Instant> = None;
            
            unsafe {
                FRAME_COUNT += 1;
                
                // Log FPS every second instead of every frame
                if let Some(last_log) = LAST_LOG_TIME {
                    if last_log.elapsed().as_secs() >= 1 {
                        let fps = FRAME_COUNT as f32;
                        println!("Capture performance: {:.1} FPS (avg frame interval: {:.1}ms)", 
                            fps,
                            1000.0 / fps
                        );
                        FRAME_COUNT = 0;
                        LAST_LOG_TIME = Some(Instant::now());
                    }
                } else {
                    LAST_LOG_TIME = Some(Instant::now());
                }
            }
        }

        // Log any encoding errors with more detail
        if let Err(e) = self.encoder.as_mut().unwrap().send_frame(frame) {
            println!("Encoding error during frame at {}s: {}", 
                current_time.as_secs_f64(),
                e
            );
            return Err(e.into());
        }

        // Capture mouse position every 16ms (approximately 60fps)
        if self.last_mouse_capture.elapsed().as_millis() >= 16 {
            unsafe {
                let mut point = POINT::default();
                if GetCursorPos(&mut point).as_bool() {
                    let is_clicked = IS_MOUSE_CLICKED.load(Ordering::SeqCst);
                    let mouse_pos = MousePosition {
                        x: point.x - MONITOR_X,
                        y: point.y - MONITOR_Y,
                        timestamp: self.start.elapsed().as_secs_f64(),
                        isClicked: is_clicked,
                    };
                    
                    if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
                        positions.push_back(mouse_pos);
                    }
                }
            }
            self.last_mouse_capture = Instant::now();
        }

        // Check if we should stop recording
        if SHOULD_STOP.load(Ordering::SeqCst) {
            // Finish encoding and stop capture
            if let Some(encoder) = self.encoder.take() {
                if let Err(e) = encoder.finish() {
                    println!("Error finishing encoder: {}", e);
                }
            }
            capture_control.stop();
        }

        Ok(())
    }

    // Called when capture session ends
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture session ended");
        Ok(())
    }
}

// Add the monitor enumeration callback
extern "system" fn monitor_enum_proc(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    unsafe {
        let monitors = &mut *(data.0 as *mut Vec<HMONITOR>);
        monitors.push(monitor);
        BOOL::from(true)
    }
}

// Replace the get_monitors command with the Win32 version
#[tauri::command]
async fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    println!("Starting monitor enumeration using Win32 API...");
    
    unsafe {
        let mut monitors: Vec<HMONITOR> = Vec::new();
        let monitors_ptr = &mut monitors as *mut Vec<HMONITOR>;
        
        EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_enum_proc),
            LPARAM(monitors_ptr as isize),
        );

        println!("Found {} monitor handles", monitors.len());
        
        let mut monitor_infos = Vec::new();
        
        for (index, &monitor) in monitors.iter().enumerate() {
            let mut monitor_info: MONITORINFOEXW = zeroed();
            monitor_info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            
            if GetMonitorInfoW(monitor, &mut monitor_info.monitorInfo as *mut _).as_bool() {
                let rect = monitor_info.monitorInfo.rcMonitor;
                println!("Monitor {}: Position ({}, {}), Size {}x{}", 
                    index,
                    rect.left, rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top
                );
                
                monitor_infos.push(MonitorInfo {
                    id: index.to_string(),
                    name: format!("Display {}", index + 1),
                    x: rect.left,
                    y: rect.top,
                    width: (rect.right - rect.left) as u32,
                    height: (rect.bottom - rect.top) as u32,
                    is_primary: monitor_info.monitorInfo.dwFlags & 1 == 1,
                });
            } else {
                println!("Failed to get info for monitor {}", index);
            }
        }

        println!("Monitor details: {:#?}", monitor_infos);
        Ok(monitor_infos)
    }
}

// Tauri command that starts the recording process
#[tauri::command]
async fn start_recording(monitor_id: Option<String>) -> Result<(), String> {
    println!("Starting recording with monitor_id: {:?}", monitor_id);

    if RECORDING.load(Ordering::SeqCst) {
        println!("Already recording, returning error");
        return Err("Already recording".to_string());
    }

    // Reset the stop flag before starting new recording
    SHOULD_STOP.store(false, Ordering::SeqCst);

    // Clear previous mouse positions
    if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
        positions.clear();
        println!("Cleared previous mouse positions");
    }

    let monitor = if let Some(id) = monitor_id {
        println!("Trying to get monitor with ID: {}", id);
        let index = id.parse::<usize>().map_err(|e| {
            println!("Failed to parse monitor ID: {:?}", e);
            "Invalid monitor ID".to_string()
        })?;
        
        Monitor::from_index(index + 1).map_err(|e| {
            println!("Failed to get monitor from index: {:?}", e);
            e.to_string()
        })?
    } else {
        println!("No monitor ID provided, using primary");
        Monitor::primary().map_err(|e| {
            println!("Failed to get primary monitor: {:?}", e);
            e.to_string()
        })?
    };

    // Get monitor dimensions for cursor offset
    let width = monitor.width().map_err(|e| {
        println!("Failed to get monitor width: {:?}", e);
        e.to_string()
    })?;
    let height = monitor.height().map_err(|e| {
        println!("Failed to get monitor height: {:?}", e);
        e.to_string()
    })?;

    println!("Monitor dimensions: {}x{}", width, height);

    // For now, assume monitor position is (0,0)
    let monitor_x = 0;
    let monitor_y = 0;

    println!("Using monitor position: ({}, {})", monitor_x, monitor_y);

    // Store positions for cursor adjustment
    unsafe {
        MONITOR_X = monitor_x;
        MONITOR_Y = monitor_y;
        println!("Stored monitor position in static variables");
    }

    // Configure capture settings
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::Default,
        ColorFormat::Bgra8,
        "Recording started".to_string(),
    );

    // Reset video path
    unsafe {
        VIDEO_PATH = None;
    }

    // Signal that we should start listening for clicks
    SHOULD_LISTEN_CLICKS.store(true, Ordering::SeqCst);

    // Spawn new thread for capture process
    thread::spawn(move || {
        if let Err(e) = CaptureHandler::start(settings) {
            eprintln!("Screen capture failed: {:?}", e);
        }
    });

    // Update recording state
    RECORDING.store(true, Ordering::SeqCst);
    println!("Recording started successfully");
    Ok(())
}

// Tauri command that stops the recording process
#[tauri::command]
async fn stop_recording(_: tauri::AppHandle) -> Result<(Vec<u8>, Vec<MousePosition>), String> {
    println!("Stopping recording and collecting mouse data...");

    if !RECORDING.load(Ordering::SeqCst) {
        return Err("Not recording".to_string());
    }

    // Signal capture to stop
    SHOULD_STOP.store(true, Ordering::SeqCst);
    
    // Immediately update recording state to false
    RECORDING.store(false, Ordering::SeqCst);
    
    // Wait a bit longer for encoder to finish and cleanup
    thread::sleep(std::time::Duration::from_millis(500));
    
    // Stop listening for clicks
    SHOULD_LISTEN_CLICKS.store(false, Ordering::SeqCst);
    IS_MOUSE_CLICKED.store(false, Ordering::SeqCst);

    // Get mouse positions
    let mouse_positions = if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
        let positions_vec: Vec<MousePosition> = positions.drain(..).collect();
        println!("Collected {} mouse positions", positions_vec.len());
        positions_vec
    } else {
        Vec::new()
    };

    // Read and return the video file without progress tracking
    unsafe {
        match &VIDEO_PATH {
            Some(path) => {
                thread::sleep(std::time::Duration::from_millis(500));
                
                let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
                let mut buffer = Vec::new();
                file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;
                
                let _ = fs::remove_file(path);
                Ok((buffer, mouse_positions))
            },
            None => Err("No video path available".to_string())
        }
    }
}

// Add new command to get mouse positions
#[tauri::command]
async fn get_mouse_positions() -> Result<Vec<MousePosition>, String> {
    println!("Retrieving mouse positions...");
    if let Ok(positions) = MOUSE_POSITIONS.lock() {
        let positions_vec: Vec<MousePosition> = positions.iter().cloned().collect();
        println!("Retrieved {} mouse positions", positions_vec.len());
        Ok(positions_vec)
    } else {
        Err("Failed to get mouse positions".to_string())
    }
}

// Add static variables for monitor position
static mut MONITOR_X: i32 = 0;
static mut MONITOR_Y: i32 = 0;

// Entry point for the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            get_monitors,
            get_mouse_positions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
