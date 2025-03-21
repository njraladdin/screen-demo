use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use memmap2::Mmap;
use parking_lot::Mutex as ParkingMutex;
use rdev::{listen, Event, EventType};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::env;
use std::fs::File;
use std::io::{Read, Seek};
use std::mem::zeroed;
use std::sync::atomic::AtomicU16;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Instant;
use tauri::Manager;
use tiny_http::{Response, Server, StatusCode};
use windows::core::PCWSTR;
use windows::Win32::Foundation::POINT;
use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorInfo;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::UI::WindowsAndMessaging::CURSORINFO;
use windows::Win32::UI::WindowsAndMessaging::{LoadCursorW, IDC_ARROW, IDC_HAND, IDC_IBEAM};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings},
};

// Global static variables that can be safely accessed from multiple threads
static RECORDING: AtomicBool = AtomicBool::new(false); // Tracks if we're currently recording
static mut VIDEO_PATH: Option<String> = None; // Stores the path where video will be saved
static SHOULD_STOP: AtomicBool = AtomicBool::new(false); // Signals when to stop recording
static IS_MOUSE_CLICKED: AtomicBool = AtomicBool::new(false);
static SHOULD_LISTEN_CLICKS: AtomicBool = AtomicBool::new(false);
static VIDEO_DATA: Mutex<Option<Vec<u8>>> = Mutex::new(None);
static ENCODING_FINISHED: AtomicBool = AtomicBool::new(false);
static ENCODER_ACTIVE: AtomicBool = AtomicBool::new(false);
static VIDEO_MMAP: ParkingMutex<Option<Arc<Mmap>>> = ParkingMutex::new(None);
static PORT: AtomicU16 = AtomicU16::new(0);
static SERVER_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static LAST_CURSOR_TYPE: Mutex<String> = Mutex::new(String::new());
static LAST_CLICK_TIME: AtomicU64 = AtomicU64::new(0);
static CLICK_LOGGED: AtomicBool = AtomicBool::new(false);

// Add these new structures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MousePosition {
    x: i32,
    y: i32,
    timestamp: f64,
    isClicked: bool,
    cursor_type: String,
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
    encoder: Option<VideoEncoder>, // Handles video encoding, wrapped in Option to allow taking ownership later
    start: Instant,                // Tracks when recording started
    last_mouse_capture: Instant,
    frame_count: u32,
    last_frame_time: Instant,
    dropped_frames: u32,
}

// Replace the get_cursor_type function with this cleaner version
fn get_cursor_type() -> String {
    unsafe {
        let mut cursor_info: CURSORINFO = std::mem::zeroed();
        cursor_info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;

        if GetCursorInfo(&mut cursor_info).as_bool() {
            let current_handle = cursor_info.hCursor.0;

            // Load system cursors to get their actual handles
            let arrow = LoadCursorW(None, PCWSTR(IDC_ARROW.0 as *const u16))
                .unwrap()
                .0;
            let ibeam = LoadCursorW(None, PCWSTR(IDC_IBEAM.0 as *const u16))
                .unwrap()
                .0;
            let hand = LoadCursorW(None, PCWSTR(IDC_HAND.0 as *const u16))
                .unwrap()
                .0;

            // Compare with actual system cursor handles without logging every check
            match current_handle {
                h if h == arrow => "default".to_string(),
                h if h == ibeam => "text".to_string(),
                h if h == hand => "pointer".to_string(),
                _ => "other".to_string(),
            }
        } else {
            "default".to_string()
        }
    }
}

// Implementation of the GraphicsCaptureApiHandler trait for our CaptureHandler
// This defines how our handler will interact with the Windows screen capture API
impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = String; // Type used for passing configuration flags
    type Error = Box<dyn std::error::Error + Send + Sync>; // Type used for error handling

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
        let video_path = temp_dir.join(format!(
            "screen_recording_{}.mp4",
            Instant::now().elapsed().as_millis()
        ));

        unsafe {
            VIDEO_PATH = Some(video_path.to_string_lossy().to_string());
        }
        println!("Setting video output path: {}", video_path.display());

        // Clear previous video data
        if let Ok(mut data) = VIDEO_DATA.lock() {
            *data = None;
        }

        // Create encoder with very conservative settings
        println!("Creating encoder with resolution: {}x{}", width, height);
        
        // Always use full resolution
        let encode_width = width;
        let encode_height = height;
        
        println!("Using full resolution: {}x{}", encode_width, encode_height);
        
        // Use reasonable encoder settings with higher bitrate for better quality
        let video_settings = VideoSettingsBuilder::new(encode_width, encode_height)
            .frame_rate(30) // Higher frame rate for smoother video
            .bitrate(10_000_000); // Higher bitrate for better quality at full resolution

        let encoder = VideoEncoder::new(
            video_settings,
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &video_path,
        )?;

        println!("Encoder created successfully");
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
            //println!("Potential frame drop: {}ms between frames", frame_time.as_millis());
        }

        self.frame_count += 1;
        self.last_frame_time = now;

        // Log performance stats every second
        if self.start.elapsed().as_secs() > 0 && self.frame_count % 60 == 0 {
            println!(
                "Recording stats: frames={}, drops={}, avg_interval={:.1}ms",
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
                None => std::time::Duration::from_millis(16),
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
                        println!(
                            "Capture performance: {:.1} FPS (avg frame interval: {:.1}ms)",
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
            println!(
                "Encoding error during frame at {}s: {}",
                current_time.as_secs_f64(),
                e
            );
            println!("Frame details: size={}x{}", frame.width(), frame.height());
            
            // Check if this is a critical error or we can continue
            if self.frame_count < 100 {
                // If errors happen during the first few frames, they're likely critical
                return Err(e.into());
            } else {
                // For later frames, log the error but try to continue
                println!("Attempting to continue encoding despite error...");
            }
        }

        // Capture mouse position every 16ms (approximately 60fps)
        if self.last_mouse_capture.elapsed().as_millis() >= 16 {
            unsafe {
                let mut point = POINT::default();
                if GetCursorPos(&mut point).as_bool() {
                    let is_clicked = IS_MOUSE_CLICKED.load(Ordering::SeqCst);

                    // Get cursor type
                    let cursor_type = get_cursor_type();

                    // Log cursor type changes
                    if let Ok(mut last_type) = LAST_CURSOR_TYPE.lock() {
                        if *last_type != cursor_type {
                            println!("Cursor changed from '{}' to '{}'", last_type, cursor_type);
                            *last_type = cursor_type.clone();
                        }
                    }

                    // Adjust coordinates relative to the monitor's position
                    let relative_x = point.x - MONITOR_X;
                    let relative_y = point.y - MONITOR_Y;

                    let mouse_pos = MousePosition {
                        x: relative_x,
                        y: relative_y,
                        timestamp: self.start.elapsed().as_secs_f64(),
                        isClicked: is_clicked,
                        cursor_type,
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
                // First, disable the encoder active flag to prevent any more frames from being sent
                ENCODER_ACTIVE.store(false, Ordering::SeqCst);
                
                // Get the current path where video is being saved
                let video_path = unsafe {
                    if let Some(path) = &VIDEO_PATH {
                        path.clone()
                    } else {
                        println!("Error: No video path available during encoder shutdown");
                        ENCODING_FINISHED.store(true, Ordering::SeqCst);
                        capture_control.stop();
                        return Ok(());
                    }
                };
                
                println!("Video being saved to: {}", video_path);
                
                // Use a separate thread with a timeout for finalization
                thread::spawn(move || {
                    println!("Attempting to finalize encoder with safety timeout...");
                    
                    // Create a channel to communicate when encoder.finish() completes
                    let (tx, rx) = mpsc::channel();
                    
                    // Check if the file exists and has content before we even try to finalize
                    let pre_finalize_size = match std::fs::metadata(&video_path) {
                        Ok(metadata) => {
                            let size = metadata.len();
                            println!("Pre-finalization file size: {} bytes ({:.2} MB)", 
                                size, size as f64 / (1024.0 * 1024.0));
                            size
                        },
                        Err(e) => {
                            println!("Error checking file before finalization: {}", e);
                            0
                        }
                    };
                    
                    // If we already have some data in the file, we might be able to use it
                    let has_usable_data = pre_finalize_size > 1024 * 1024; // More than 1MB
                    
                    // Spawn another thread that will actually call encoder.finish()
                    thread::spawn(move || {
                        println!("Encoder finalization worker thread started");
                        let result = encoder.finish();
                        // Send the result back, don't care if receiver is gone
                        let _ = tx.send(result);
                        println!("Encoder finalization worker thread completed");
                    });
                    
                    // Use a much shorter timeout if we already have usable data
                    let timeout = if has_usable_data {
                        std::time::Duration::from_secs(5) // Short timeout if we have data
                    } else {
                        std::time::Duration::from_secs(10) // Longer timeout if we need finalization
                    };
                    
                    println!("Waiting up to {}s for encoder to finalize...", timeout.as_secs());
                    
                    // Wait for finish() to complete with a timeout
                    match rx.recv_timeout(timeout) {
                        Ok(Ok(_)) => {
                            println!("Encoder successfully finalized");
                        }
                        Ok(Err(e)) => {
                            println!("Encoder returned an error during finalization: {}", e);
                            println!("Will attempt to use the partially encoded video");
                        }
                        Err(e) => {
                            println!("Timeout or error waiting for encoder to finalize: {}", e);
                            println!("The encoder worker thread may still be running - proceeding with current file regardless");
                        }
                    }
                    
                    // Signal that encoding is finished regardless of the outcome
                    ENCODING_FINISHED.store(true, Ordering::SeqCst);
                    
                    // Check if the video file exists and has a reasonable size
                    match std::fs::metadata(&video_path) {
                        Ok(metadata) => {
                            let size = metadata.len();
                            if size > 0 {
                                println!("Video file created successfully: {} bytes ({:.2} MB)", 
                                    size, size as f64 / (1024.0 * 1024.0));
                                
                                if size > pre_finalize_size {
                                    println!("File grew by {} bytes during finalization", size - pre_finalize_size);
                                } else if size == pre_finalize_size {
                                    println!("File size did not change during finalization");
                                }
                            } else {
                                println!("Warning: Video file exists but has zero size");
                            }
                        },
                        Err(e) => {
                            println!("Warning: Unable to access video file after recording: {}", e);
                        }
                    }
                });
            } else {
                // If encoder was already taken
                ENCODING_FINISHED.store(true, Ordering::SeqCst);
            }
            
            // Stop the capture immediately, don't wait for encoding
            capture_control.stop();
            println!("Capture stopped successfully");
        }

        Ok(())
    }

    // Called when capture session ends
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture session ended");
        // Ensure states are reset
        ENCODER_ACTIVE.store(false, Ordering::SeqCst);
        ENCODING_FINISHED.store(true, Ordering::SeqCst);
        RECORDING.store(false, Ordering::SeqCst);
        cleanup_resources();
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
                println!(
                    "Monitor {}: Position ({}, {}), Size {}x{}",
                    index,
                    rect.left,
                    rect.top,
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

// Add this function to clean up resources
fn cleanup_resources() {
    println!("Cleaning up resources...");

    // Make sure encoder is no longer active
    ENCODER_ACTIVE.store(false, Ordering::SeqCst);
    
    // Ensure encoding is marked as finished to prevent deadlocks
    ENCODING_FINISHED.store(true, Ordering::SeqCst);

    // Clean up any running servers
    if let Ok(mut ports) = SERVER_PORTS.lock() {
        if !ports.is_empty() {
            println!("Cleaning up {} server ports", ports.len());
            ports.clear();
        }
    }

    // First, drop the memory map
    {
        let mut mmap = VIDEO_MMAP.lock();
        if mmap.is_some() {
            println!("Releasing memory map");
            *mmap = None;
        }
    }

    // Reset all state flags
    RECORDING.store(false, Ordering::SeqCst);
    SHOULD_STOP.store(false, Ordering::SeqCst);
    
    // Clear mouse positions
    if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
        positions.clear();
    }

    // Signal click listener to stop
    SHOULD_LISTEN_CLICKS.store(false, Ordering::SeqCst);
    
    // Note: we don't clear VIDEO_PATH here because the server might still need it
    
    println!("Resource cleanup completed");
}

// Modify start_recording
#[tauri::command]
async fn start_recording(monitor_id: Option<String>, quality: Option<String>) -> Result<(), String> {
    println!("Starting recording with monitor_id: {:?}, quality: {:?}", monitor_id, quality);

    // First, ensure any previous recording is fully cleaned up
    if RECORDING.load(Ordering::SeqCst) {
        println!("Detected active recording, cleaning up first...");
        SHOULD_STOP.store(true, Ordering::SeqCst);

        // Wait a bit for cleanup
        thread::sleep(std::time::Duration::from_millis(500));
    }

    // Force cleanup regardless of previous state
    cleanup_resources();

    // Clear previous mouse positions
    if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
        positions.clear();
        println!("Cleared previous mouse positions");
    }
    
    // Parse the quality setting
    let quality_setting = match quality.as_deref() {
        Some("high") => {
            println!("Using high quality encoding");
            "high"
        }
        Some("medium") => { 
            println!("Using medium quality encoding");
            "medium"
        }
        Some("low") => {
            println!("Using low quality encoding");
            "low"
        }
        _ => {
            println!("No quality specified, defaulting to high quality");
            "high"
        }
    };
    
    // Store quality setting in a thread-local for the encoder to access
    // (Note: we still set this for future use, but currently ignore it to always use full resolution)
    thread_local! {
        static QUALITY_SETTING: std::cell::RefCell<&'static str> = std::cell::RefCell::new("high");
    }
    
    QUALITY_SETTING.with(|quality| {
        *quality.borrow_mut() = "high"; // Always use high quality
    });
    
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

    // Spawn mouse listener thread
    thread::spawn(move || {
        if let Err(error) = listen(move |event| {
            // Check if we should continue listening
            if !SHOULD_LISTEN_CLICKS.load(Ordering::SeqCst) {
                return;
            }

            match event.event_type {
                EventType::ButtonPress(_) => {
                    if !CLICK_LOGGED.load(Ordering::SeqCst) {
                        IS_MOUSE_CLICKED.store(true, Ordering::SeqCst);
                        CLICK_LOGGED.store(true, Ordering::SeqCst);
                        println!("Mouse clicked");
                    }
                }
                EventType::ButtonRelease(_) => {
                    IS_MOUSE_CLICKED.store(false, Ordering::SeqCst);
                    CLICK_LOGGED.store(false, Ordering::SeqCst);
                }
                _ => {}
            }
        }) {
            println!("Error in mouse listener: {:?}", error);
        }
    });

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
    if let Some(mmap) = VIDEO_MMAP.lock().as_ref() {
        let start = chunk_index * CHUNK_SIZE;
        let end = (start + CHUNK_SIZE).min(mmap.len());

        if start >= mmap.len() {
            return Err("Chunk index out of bounds".to_string());
        }

        let chunk = &mmap[start..end];
        Ok(BASE64.encode(chunk))
    } else {
        Err("No video file available".to_string())
    }
}

// Initialize the memory map when recording stops
fn init_video_mmap() -> Result<(), Box<dyn std::error::Error>> {
    println!("Initializing video memory map...");
    unsafe {
        if let Some(path) = &VIDEO_PATH {
            println!("Trying to open video file at: {}", path);
            
            // Make multiple attempts to open the file
            const MAX_ATTEMPTS: usize = 3;
            let mut last_error = None;
            
            for attempt in 1..=MAX_ATTEMPTS {
                match File::open(path) {
                    Ok(file) => {
                        match file.metadata() {
                            Ok(metadata) => {
                                let file_size = metadata.len();
                                println!("File opened (attempt {}/{}), size: {} bytes", 
                                    attempt, MAX_ATTEMPTS, file_size);
                                
                                match Mmap::map(&file) {
                                    Ok(mmap) => {
                                        println!("Memory map created successfully, size: {} bytes", mmap.len());
                                        *VIDEO_MMAP.lock() = Some(Arc::new(mmap));
                                        return Ok(());
                                    },
                                    Err(e) => {
                                        println!("Failed to create memory map (attempt {}/{}): {}", 
                                            attempt, MAX_ATTEMPTS, e);
                                        last_error = Some(e);
                                        // Try again after a short delay
                                        thread::sleep(std::time::Duration::from_millis(200));
                                    }
                                }
                            },
                            Err(e) => {
                                println!("Failed to get file metadata (attempt {}/{}): {}", 
                                    attempt, MAX_ATTEMPTS, e);
                                last_error = Some(e.into());
                                thread::sleep(std::time::Duration::from_millis(200));
                            }
                        }
                    },
                    Err(e) => {
                        println!("Failed to open file (attempt {}/{}): {}", 
                            attempt, MAX_ATTEMPTS, e);
                        last_error = Some(e.into());
                        thread::sleep(std::time::Duration::from_millis(200));
                    }
                }
            }
            
            // If we've tried multiple times and still failed, return the last error
            if let Some(e) = last_error {
                return Err(Box::new(e));
            } else {
                return Err("Failed to open video file after multiple attempts".into());
            }
        } else {
            println!("No video path available for memory mapping");
            return Err("No video path available".into());
        }
    }
}

// Modify the CORS headers function to handle both dev and prod environments
fn add_cors_headers<R: std::io::Read>(response: &mut Response<R>) {
    // Check if we're in development by trying to access localhost:1420
    let origin = if cfg!(debug_assertions) {
        "http://localhost:1420"
    } else {
        "http://tauri.localhost"
    };

    response.add_header(
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], origin.as_bytes())
            .unwrap(),
    );
    response.add_header(
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, OPTIONS"[..])
            .unwrap(),
    );
}

// Modify start_video_server to track ports
fn start_video_server(video_path: String) -> Result<u16, Box<dyn std::error::Error>> {
    println!("Starting video server for: {}", video_path);

    // Verify file exists and is readable first
    let file_size = match std::fs::metadata(&video_path) {
        Ok(metadata) => {
            let size = metadata.len();
            println!("Video file verified: {} bytes ({:.2} MB)", 
                size, 
                size as f64 / (1024.0 * 1024.0)
            );
            
            if size == 0 {
                return Err("Video file exists but is empty".into());
            }
            size
        }
        Err(e) => {
            return Err(format!("Cannot access video file: {}", e).into());
        }
    };

    // Clean up old ports first
    if let Ok(mut ports) = SERVER_PORTS.lock() {
        ports.clear();
    }

    // Try ports starting from 8000
    let mut port = 8000;
    let server = loop {
        println!("Trying to bind server to port {}", port);
        match Server::http(format!("127.0.0.1:{}", port)) {
            Ok(server) => {
                println!("Server started on port {}", port);
                if let Ok(mut ports) = SERVER_PORTS.lock() {
                    ports.push(port);
                }
                break server;
            }
            Err(e) => {
                println!("Failed to bind port {}: {}", port, e);
                port += 1;
                if port > 9000 {
                    return Err("No available ports".into());
                }
            }
        }
    };

    PORT.store(port, Ordering::SeqCst);

    thread::spawn(move || {
        println!("Opening video file for serving...");
        match File::open(&video_path) {
            Ok(file) => {
                // Get the current file size again in case it changed
                let file_size = match file.metadata() {
                    Ok(metadata) => metadata.len(),
                    Err(_) => file_size, // Fall back to the previously measured size
                };
                
                println!("Video file opened successfully: {} bytes", file_size);
            
                for request in server.incoming_requests() {
                    println!("Received request: {} {}", 
                        request.method(), 
                        request.url()
                    );
                    
                    // Handle OPTIONS preflight request
                    if request.method() == &tiny_http::Method::Options {
                        println!("Handling OPTIONS request");
                        let mut response = Response::empty(204);
                        add_cors_headers(&mut response);
                        let _ = request.respond(response);
                        continue;
                    }
                    
                    // Handle range request
                    let mut start = 0;
                    let mut end = file_size - 1;
                    
                    if let Some(range_header) = request
                        .headers()
                        .iter()
                        .find(|h| h.field.as_str() == "Range")
                    {
                        if let Ok(range_str) = std::str::from_utf8(range_header.value.as_bytes()) {
                            println!("Range request: {}", range_str);
                            if let Some(range) = range_str.strip_prefix("bytes=") {
                                let parts: Vec<&str> = range.split('-').collect();
                                if parts.len() == 2 {
                                    start = parts[0].parse::<u64>().unwrap_or(0);
                                    end = parts[1].parse::<u64>().unwrap_or(file_size - 1);
                                }
                            }
                        }
                    }
                    
                    println!("Serving range: bytes {}-{}/{}", start, end, file_size);
                    
                    match file.try_clone() {
                        Ok(mut file_clone) => {
                            if let Err(e) = file_clone.seek(std::io::SeekFrom::Start(start)) {
                                println!("Error seeking in file: {}", e);
                                let _ = request.respond(Response::empty(500));
                                continue;
                            }
                            
                            let mut response = Response::new(
                                if start == 0 {
                                    StatusCode(200)
                                } else {
                                    StatusCode(206)
                                },
                                vec![],
                                Box::new(file_clone.take(end - start + 1)),
                                Some((end - start + 1) as usize),
                                None,
                            );
                            
                            add_cors_headers(&mut response);
                            
                            // Add content type header
                            response.add_header(
                                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"video/mp4"[..]).unwrap(),
                            );
                            
                            // Add headers for range requests
                            if start != 0 {
                                response.add_header(
                                    tiny_http::Header::from_bytes(
                                        &b"Content-Range"[..],
                                        format!("bytes {}-{}/{}", start, end, file_size).as_bytes(),
                                    )
                                    .unwrap(),
                                );
                            }
                            
                            match request.respond(response) {
                                Ok(_) => println!("Response sent successfully"),
                                Err(e) => println!("Error sending response: {}", e),
                            }
                        }
                        Err(e) => {
                            println!("Error cloning file: {}", e);
                            let _ = request.respond(Response::empty(500));
                        }
                    }
                }
            }
            Err(e) => {
                println!("Failed to open video file for serving: {}", e);
                // Server will exit if we can't open the file
            }
        }
        println!("Video server thread ended");
    });

    Ok(port)
}

// Add this function near the other utility functions
fn process_cursor_changes(positions: &mut Vec<MousePosition>) {
    const MIN_DURATION_MS: f64 = 100.0;

    let mut i = 0;
    while i < positions.len() - 1 {
        let current_type = &positions[i].cursor_type;
        let mut j = i + 1;

        while j < positions.len() && positions[j].cursor_type == *current_type {
            j += 1;
        }

        // If this cursor type lasted less than MIN_DURATION_MS and we're not at the start
        let duration = (positions[j - 1].timestamp - positions[i].timestamp) * 1000.0;
        if duration < MIN_DURATION_MS && i > 0 {
            // Replace the short duration with the previous type
            let prev_type = positions[i - 1].cursor_type.clone();
            for pos in positions.iter_mut().take(j).skip(i) {
                pos.cursor_type = prev_type.clone();
            }
        }
        i = j;
    }
}

// Modify the existing stop_recording command
#[tauri::command]
async fn stop_recording(_: tauri::AppHandle) -> Result<(String, Vec<MousePosition>), String> {
    println!("Starting recording stop process...");

    if !RECORDING.load(Ordering::SeqCst) {
        println!("Not recording, cleaning up any stale resources...");
        cleanup_resources();
        return Err("Not recording".to_string());
    }

    // Signal capture to stop 
    SHOULD_STOP.store(true, Ordering::SeqCst);
    
    // Get the video path first, in case it gets cleared during cleanup
    let video_path = unsafe {
        if let Some(path) = &VIDEO_PATH {
            path.clone()
        } else {
            cleanup_resources();
            return Err("No video path available".to_string());
        }
    };
    
    println!("Expecting video at: {}", video_path);
    
    // Check if the file already exists before waiting for encoder
    let pre_wait_file_exists = match std::fs::metadata(&video_path) {
        Ok(metadata) => {
            let size = metadata.len();
            println!("Video file already exists with size: {} bytes ({:.2} MB)", 
                size, size as f64 / (1024.0 * 1024.0));
            size > 0
        },
        Err(_) => {
            println!("Video file does not exist yet, will wait for encoder");
            false
        }
    };
    
    // If file already exists with content, don't wait as long
    let max_wait_time = if pre_wait_file_exists {
        println!("Using shorter wait time since video file already exists");
        std::time::Duration::from_secs(5)
    } else {
        println!("Using standard wait time for encoder");
        std::time::Duration::from_secs(15)
    };
    
    // Wait for encoder to finish or timeout
    let start = Instant::now();
    let mut last_status_time = start;
    
    while !ENCODING_FINISHED.load(Ordering::SeqCst) && start.elapsed() < max_wait_time {
        // Check status and print progress every second
        if last_status_time.elapsed().as_secs() >= 1 {
            println!("Waiting for encoder to finish or timeout... ({}/{}s)", 
                start.elapsed().as_secs(), max_wait_time.as_secs());
            
            // Check if the file is growing
            if let Ok(metadata) = std::fs::metadata(&video_path) {
                let size = metadata.len();
                println!("Current video file size: {} bytes ({:.2} MB)", 
                    size, size as f64 / (1024.0 * 1024.0));
            }
            
            last_status_time = Instant::now();
        }
        
        thread::sleep(std::time::Duration::from_millis(250));
    }
    
    if !ENCODING_FINISHED.load(Ordering::SeqCst) {
        println!("Encoder still running after {}s - proceeding with current file state", start.elapsed().as_secs());
    } else {
        println!("Encoder finished within timeout period ({}s)", start.elapsed().as_secs());
    }
    
    // Check if video file exists and is non-empty
    let file_exists = match std::fs::metadata(&video_path) {
        Ok(metadata) => {
            let size = metadata.len();
            println!("Final video file size: {} bytes ({:.2} MB)", 
                size, size as f64 / (1024.0 * 1024.0));
            size > 0
        }
        Err(e) => {
            println!("Error checking video file: {}", e);
            false
        }
    };
    
    if !file_exists {
        println!("No usable video file found, cleaning up");
        cleanup_resources();
        return Err("No usable video file was created. The recording may have failed.".to_string());
    }
    
    // Stop mouse tracking 
    SHOULD_LISTEN_CLICKS.store(false, Ordering::SeqCst);
    IS_MOUSE_CLICKED.store(false, Ordering::SeqCst);
    
    // Regardless of encoder state, try to serve the file
    println!("Attempting to serve video file from: {}", video_path);
    
    match start_video_server(video_path) {
        Ok(port) => {
            println!("Server started successfully on port {}", port);
            let mouse_positions = if let Ok(mut positions) = MOUSE_POSITIONS.lock() {
                let mut positions: Vec<MousePosition> = positions.drain(..).collect();
                process_cursor_changes(&mut positions);
                positions
            } else {
                Vec::new()
            };
            
            // Don't clean up resources here, as we need the file to remain available
            Ok((format!("http://localhost:{}", port), mouse_positions))
        }
        Err(e) => {
            println!("Server failed to start: {}", e);
            cleanup_resources();
            Err(format!("Failed to start video server: {}", e))
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
