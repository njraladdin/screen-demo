// Import required functionality from the standard library and external crates
use std::sync::atomic::{AtomicBool, Ordering};  // For thread-safe boolean values
use std::time::Instant;  // For measuring time
use std::thread;  // For spawning new threads
use std::fs;      // For file operations
use std::env;     // For environment-related operations
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},  // Core screen capture functionality
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder},  // Video encoding
    frame::Frame,  // For handling individual frames
    graphics_capture_api::InternalCaptureControl,  // Control capture process
    monitor::Monitor,  // For accessing monitor information
    settings::{ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings},  // Capture settings
};

// Global static variables that can be safely accessed from multiple threads
static RECORDING: AtomicBool = AtomicBool::new(false);  // Tracks if we're currently recording
static mut VIDEO_PATH: Option<String> = None;  // Stores the path where video will be saved
static SHOULD_STOP: AtomicBool = AtomicBool::new(false);  // Signals when to stop recording

// Main struct that handles the screen capture process
struct CaptureHandler {
    encoder: Option<VideoEncoder>,  // Handles video encoding, wrapped in Option to allow taking ownership later
    start: Instant,  // Tracks when recording started
}

// Implementation of the GraphicsCaptureApiHandler trait for our CaptureHandler
// This defines how our handler will interact with the Windows screen capture API
impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = String;  // Type used for passing configuration flags
    type Error = Box<dyn std::error::Error + Send + Sync>;  // Type used for error handling

    // Called when creating a new capture session
    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        println!("Created with Flags: {}", ctx.flags);

        // Create temporary file path for the video
        let temp_dir = env::temp_dir();
        let video_path = temp_dir.join("screen_recording.mp4");
        
        // Store the video path globally (unsafe because we're modifying a static variable)
        unsafe {
            VIDEO_PATH = Some(video_path.to_string_lossy().to_string());
        }

        // Configure video encoding settings
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(1920, 1080)  // Set resolution
                .frame_rate(30)  // Set FPS
                .bitrate(5_000_000),  // Set bitrate (5 Mbps)
            AudioSettingsBuilder::default().disabled(true),  // Disable audio
            ContainerSettingsBuilder::default(),  // Use default MP4 container settings
            &video_path,  // Where to save the video
        )?;  // '?' operator propagates any errors

        // Return new CaptureHandler instance
        Ok(Self {
            encoder: Some(encoder),
            start: Instant::now(),  // Start timing
        })
    }

    // Called every time a new frame is captured
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        println!("\rRecording for: {} seconds", self.start.elapsed().as_secs());

        // Encode the frame
        self.encoder.as_mut().unwrap().send_frame(frame)?;

        // Check if we should stop recording
        if SHOULD_STOP.load(Ordering::SeqCst) {
            // Finish encoding and stop capture
            self.encoder.take().unwrap().finish()?;
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
    println!("Starting recording process...");

    // Check if already recording
    if RECORDING.load(Ordering::SeqCst) {
        return Err("Already recording".to_string());
    }

    // Reset stop flag
    SHOULD_STOP.store(false, Ordering::SeqCst);

    // Get primary monitor for recording
    let primary_monitor = Monitor::primary().map_err(|e| e.to_string())?;

    // Configure capture settings
    let settings = Settings::new(
        primary_monitor,
        CursorCaptureSettings::Default,  // Include cursor in recording
        DrawBorderSettings::Default,      // Draw border around captured area
        ColorFormat::Bgra8,              // Color format to use
        "Recording started".to_string(),  // Message to pass to handler
    );

    // Reset video path
    unsafe {
        VIDEO_PATH = None;
    }

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
async fn stop_recording() -> Result<Vec<u8>, String> {
    println!("Stopping recording...");

    // Check if we're actually recording
    if !RECORDING.load(Ordering::SeqCst) {
        return Err("Not recording".to_string());
    }

    // Immediately update recording state to false
    RECORDING.store(false, Ordering::SeqCst);

    // Signal capture to stop
    SHOULD_STOP.store(true, Ordering::SeqCst);
    
    // Wait a bit for encoder to finish
    thread::sleep(std::time::Duration::from_millis(100));
    
    // Read and return the video file
    unsafe {
        match &VIDEO_PATH {
            Some(path) => {
                println!("Video path: {}", path);
                thread::sleep(std::time::Duration::from_millis(500));
                
                // Read file into memory
                match fs::read(path) {
                    Ok(data) => {
                        println!("Successfully read video file");
                        println!("Video data size: {} bytes", data.len());
                        let first_bytes: Vec<u8> = data.iter().take(16).cloned().collect();
                        println!("First 16 bytes: {:?}", first_bytes);
                        let _ = fs::remove_file(path);  // Clean up temporary file
                        Ok(data)
                    },
                    Err(e) => {
                        println!("Failed to read video file: {}", e);
                        Err(format!("Failed to read video file: {}", e))
                    }
                }
            },
            None => {
                println!("No video path available");
                Err("No video path available".to_string())
            }
        }
    }
}

// Entry point for the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![start_recording, stop_recording])  // Register our commands
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
