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

// Tauri command that starts the recording process
#[tauri::command]
async fn start_recording() -> Result<(), String> {
    println!("Starting recording");

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

    let monitor = Monitor::primary().map_err(|e| {
        println!("Failed to get primary monitor: {:?}", e);
        e.to_string()
    })?;

    // Get monitor position - for now, assume primary monitor starts at (0,0)
    // We'll adjust this if needed based on testing
    unsafe {
        MONITOR_X = 0;
        MONITOR_Y = 0;
        println!("Set monitor offset to: ({}, {})", MONITOR_X, MONITOR_Y);
    }

    println!("Successfully got primary monitor");

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

    // Start mouse click listener
    thread::spawn(|| {
        if let Err(error) = listen(|event| {
            // Check if we should still be listening
            if !SHOULD_LISTEN_CLICKS.load(Ordering::SeqCst) {
                return;
            }
            match event.event_type {
                EventType::ButtonPress(button) => {
                    if button == rdev::Button::Left {
                        IS_MOUSE_CLICKED.store(true, Ordering::SeqCst);
                        println!("Mouse clicked!");
                    }
                }
                EventType::ButtonRelease(button) => {
                    if button == rdev::Button::Left {
                        IS_MOUSE_CLICKED.store(false, Ordering::SeqCst);
                        println!("Mouse released!");
                    }
                }
                _ => {}
            }
        }) {
            eprintln!("Error: {:?}", error);
        }
    });

    // Spawn new thread for capture process
    thread::spawn(move || {
        CaptureHandler::start(settings).expect("Screen capture failed");
    });

    // Update recording state
    RECORDING.store(true, Ordering::SeqCst);
    println!("Recording started successfully");
    Ok(())
}

// Tauri command that stops the recording process
#[tauri::command]
async fn stop_recording(app_handle: tauri::AppHandle) -> Result<(Vec<u8>, Vec<MousePosition>), String> {
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
            get_mouse_positions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
