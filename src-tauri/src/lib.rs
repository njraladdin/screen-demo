use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use std::thread;
use std::fs::{self, File};
use std::env;
use std::io::{self, Read, Seek};
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
use tauri::Manager;
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
use std::mem::zeroed;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

// Global static variables that can be safely accessed from multiple threads
static RECORDING: AtomicBool = AtomicBool::new(false);  // Tracks if we're currently recording
static mut VIDEO_PATH: Option<String> = None;  // Stores the path where video will be saved
static SHOULD_STOP: AtomicBool = AtomicBool::new(false);  // Signals when to stop recording
static IS_MOUSE_CLICKED: AtomicBool = AtomicBool::new(false);
static SHOULD_LISTEN_CLICKS: AtomicBool = AtomicBool::new(false);
static VIDEO_DATA: Mutex<Option<Vec<u8>>> = Mutex::new(None);
static ENCODING_FINISHED: AtomicBool = AtomicBool::new(false);
static ENCODER_ACTIVE: AtomicBool = AtomicBool::new(false);

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
    frame_count: u32,
    last_frame_time: Instant,
    dropped_frames: u32,
}

// Implementation of the GraphicsCaptureApiHandler trait for our CaptureHandler
// This defines how our handler will interact with the Windows screen capture API
impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = String;  // Type used for passing configuration flags
    type Error = Box<dyn std::error::Error + Send + Sync>;  // Type used for error handling

    // Called when creating a new capture session
    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        println!("Created capture handler with flags: {}", ctx.flags);

        // Reset all states
        SHOULD_STOP.store(false, Ordering::SeqCst);
        ENCODING_FINISHED.store(false, Ordering::SeqCst);
        ENCODER_ACTIVE.store(false, Ordering::SeqCst);

        // Get primary monitor dimensions
        let monitor = Monitor::primary()?;
        let width = monitor.width()?;
        let height = monitor.height()?;
        println!("Recording at resolution: {}x{}", width, height);

        // Create temporary file path for the video
        let temp_dir = env::temp_dir();
        let video_path = temp_dir.join(format!("screen_recording_{}.mp4", Instant::now().elapsed().as_millis()));
        
        unsafe {
            VIDEO_PATH = Some(video_path.to_string_lossy().to_string());
        }

        // Clear previous video data
        if let Ok(mut data) = VIDEO_DATA.lock() {
            *data = None;
        }

        // Create encoder
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(width, height)
                .frame_rate(60)
                .bitrate(10_000_000),  // Reduced bitrate for faster processing
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &video_path,
        )?;

        ENCODER_ACTIVE.store(true, Ordering::SeqCst);

        Ok(Self {
            encoder: Some(encoder),
            start: Instant::now(),
            last_mouse_capture: Instant::now(),
            frame_count: 0,
            last_frame_time: Instant::now(),
            dropped_frames: 0,
        })
    }

    // Called every time a new frame is captured
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Only process frames if encoder is active
        if !ENCODER_ACTIVE.load(Ordering::SeqCst) {
            return Ok(());
        }

        let now = Instant::now();
        let frame_time = now.duration_since(self.last_frame_time);
        
        // Monitor for potential frame drops (expecting ~16.7ms between frames at 60fps)
        if frame_time.as_millis() > 20 {
            self.dropped_frames += 1;
            println!("Potential frame drop: {}ms between frames", frame_time.as_millis());
        }

        self.frame_count += 1;
        self.last_frame_time = now;

        // Log performance stats every second
        if self.start.elapsed().as_secs() > 0 && self.frame_count % 60 == 0 {
            println!("Recording stats: frames={}, drops={}, avg_interval={:.1}ms", 
                self.frame_count,
                self.dropped_frames,
                self.start.elapsed().as_millis() as f32 / self.frame_count as f32
            );
        }

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
                Some(prev) => now.duration_since(prev),
                None => std::time::Duration::from_millis(16)
            };
            *last = Some(now);
            delta
        });

        // Log frame timing during fast changes
        if frame_delta.as_millis() < 20 {
            static mut FRAME_COUNT: u32 = 0;
            static mut LAST_LOG_TIME: Option<Instant> = None;
            
            unsafe {
                FRAME_COUNT += 1;
                
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
            println!("Frame details: size={}x{}", 
                frame.width(), 
                frame.height()
            );
            return Err(e.into());
        }

        // Capture mouse position every 16ms (approximately 60fps)
        if self.last_mouse_capture.elapsed().as_millis() >= 16 {
            unsafe {
                let mut point = POINT::default();
                if GetCursorPos(&mut point).as_bool() {
                    let is_clicked = IS_MOUSE_CLICKED.load(Ordering::SeqCst);
                    
                    // Adjust coordinates relative to the monitor's position
                    let relative_x = point.x - MONITOR_X;
                    let relative_y = point.y - MONITOR_Y;
                    
                    let mouse_pos = MousePosition {
                        x: relative_x,
                        y: relative_y,
                        timestamp: self.start.elapsed().as_secs_f64(),
                        isClicked: is_clicked,
                    };
                    
                    // Only store positions that are within the monitor bounds
                    if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
                        positions.push_back(mouse_pos);
                    }
                }
            }
            self.last_mouse_capture = Instant::now();
        }

        // Check if we should stop recording
        if SHOULD_STOP.load(Ordering::SeqCst) {
            println!("Stopping capture and finalizing encoder...");
            if let Some(encoder) = self.encoder.take() {
                ENCODER_ACTIVE.store(false, Ordering::SeqCst);
                if let Err(e) = encoder.finish() {
                    println!("Error finishing encoder: {}", e);
                }
                ENCODING_FINISHED.store(true, Ordering::SeqCst);
            }
            capture_control.stop();
        }

        Ok(())
    }

    // Called when capture session ends
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture session ended");
        // Ensure states are reset
        ENCODER_ACTIVE.store(false, Ordering::SeqCst);
        ENCODING_FINISHED.store(true, Ordering::SeqCst);
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

    // Reset all states
    SHOULD_STOP.store(false, Ordering::SeqCst);
    ENCODING_FINISHED.store(false, Ordering::SeqCst);
    ENCODER_ACTIVE.store(false, Ordering::SeqCst);

    // Clear previous mouse positions
    if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
        positions.clear();
        println!("Cleared previous mouse positions");
    }

    let monitor = if let Some(ref id) = monitor_id {
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

    // Get monitor info to get the correct position
    unsafe {
        let mut monitors: Vec<HMONITOR> = Vec::new();
        let monitors_ptr = &mut monitors as *mut Vec<HMONITOR>;
        
        EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_enum_proc),
            LPARAM(monitors_ptr as isize),
        );

        let monitor_index = monitor_id
            .as_ref()
            .and_then(|id| id.parse::<usize>().ok())
            .unwrap_or(0);

        if let Some(&hmonitor) = monitors.get(monitor_index) {
            let mut monitor_info: MONITORINFOEXW = zeroed();
            monitor_info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            
            if GetMonitorInfoW(hmonitor, &mut monitor_info.monitorInfo as *mut _).as_bool() {
                let rect = monitor_info.monitorInfo.rcMonitor;
                MONITOR_X = rect.left;
                MONITOR_Y = rect.top;
                println!("Set monitor position to: ({}, {})", MONITOR_X, MONITOR_Y);
            }
        }
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

// Add these constants near the top
const CHUNK_SIZE: usize = 1024 * 1024; // 1MB chunks

// Add this new command
#[tauri::command]
async fn get_video_chunk(chunk_index: usize) -> Result<String, String> {
    unsafe {
        if let Some(path) = &VIDEO_PATH {
            match File::open(path) {
                Ok(mut file) => {
                    // Seek to the correct position
                    if let Err(e) = file.seek(std::io::SeekFrom::Start((chunk_index * CHUNK_SIZE) as u64)) {
                        return Err(format!("Failed to seek: {}", e));
                    }

                    let mut buffer = vec![0u8; CHUNK_SIZE];
                    match file.read(&mut buffer) {
                        Ok(n) => {
                            buffer.truncate(n); // Only keep what we actually read
                            Ok(BASE64.encode(&buffer))
                        },
                        Err(e) => Err(format!("Failed to read chunk: {}", e))
                    }
                },
                Err(e) => Err(format!("Failed to open video file: {}", e))
            }
        } else {
            Err("No video path available".to_string())
        }
    }
}

// Modify stop_recording to return metadata instead of the full file
#[tauri::command]
async fn stop_recording(_: tauri::AppHandle) -> Result<(usize, Vec<MousePosition>), String> {
    println!("Starting recording stop process...");

    if !RECORDING.load(Ordering::SeqCst) || !ENCODER_ACTIVE.load(Ordering::SeqCst) {
        return Err("Not recording".to_string());
    }

    // Signal capture to stop
    SHOULD_STOP.store(true, Ordering::SeqCst);
    RECORDING.store(false, Ordering::SeqCst);

    // Wait for encoder to finish with timeout
    let start = Instant::now();
    while !ENCODING_FINISHED.load(Ordering::SeqCst) {
        thread::sleep(std::time::Duration::from_millis(100));
        if start.elapsed().as_secs() > 5 {
            ENCODER_ACTIVE.store(false, Ordering::SeqCst);
            return Err("Timeout waiting for encoder to finish".to_string());
        }
    }

    // Stop mouse tracking
    SHOULD_LISTEN_CLICKS.store(false, Ordering::SeqCst);
    IS_MOUSE_CLICKED.store(false, Ordering::SeqCst);

    // Collect mouse positions
    let mouse_positions = if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
        positions.drain(..).collect()
    } else {
        Vec::new()
    };

    // Get file size instead of reading the file
    unsafe {
        if let Some(path) = &VIDEO_PATH {
            match fs::metadata(path) {
                Ok(metadata) => {
                    let total_chunks = (metadata.len() as usize + CHUNK_SIZE - 1) / CHUNK_SIZE;
                    Ok((total_chunks, mouse_positions))
                },
                Err(e) => Err(format!("Failed to get video metadata: {}", e))
            }
        } else {
            Err("No video path available".to_string())
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
            get_video_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
