//! CPU-decoded ByteVC2 playback. mpv control and rendering have independent
//! threads; AppKit only presents completed RGB frames on its main run loop.
#[path = "bytevc2_video_mpv.rs"]
mod mpv;
use block2::RcBlock;
use nsh_platform_macos::{
    ComponentContext, ComponentFactory, NativeComponent,
    objc2::{AnyThread, MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSBitmapImageRep, NSDeviceRGBColorSpace, NSImage, NSImageScaling, NSImageView, NSView,
    },
    objc2_foundation::{NSRect, NSRunLoop, NSRunLoopCommonModes, NSSize, NSTimer},
};
use serde_json::{Value, json};
use std::{
    ffi::c_void,
    ptr::{self, NonNull},
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

pub(super) fn available() -> bool {
    mpv::api().is_ok()
}
pub(super) fn factory() -> ComponentFactory {
    Rc::new(|cx| Box::new(Video::new(cx)))
}

enum Request {
    Source(String),
    Pause(bool),
    Mute(bool),
    Rate(f64),
    Seek(f64),
    Shutdown,
}
struct Frame {
    width: usize,
    height: usize,
    stride: usize,
    pixels: Vec<u8>,
}
#[derive(Default)]
struct Shared {
    size: AtomicU64,
    stop: AtomicBool,
    frame: Mutex<Option<Frame>>,
}
struct Video {
    view: Retained<NSImageView>,
    timer: Retained<NSTimer>,
    tx: mpsc::Sender<Request>,
    worker: Option<thread::JoinHandle<()>>,
    source: String,
    cx: ComponentContext,
}
impl Video {
    fn new(cx: ComponentContext) -> Self {
        let mtm = MainThreadMarker::new().expect("native component requires AppKit main thread");
        let view = NSImageView::initWithFrame(NSImageView::alloc(mtm), NSRect::ZERO);
        view.setEditable(false);
        view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel();
        let worker_shared = shared.clone();
        let worker_cx = cx.clone();
        let worker = thread::Builder::new()
            .name("hg-bvc2-control".into())
            .spawn(move || {
                if let Err(message) = playback(rx, worker_shared, &worker_cx) {
                    error(&worker_cx, "BYTEVC2_NATIVE", message);
                }
            });
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(e) => {
                error(&cx, "BYTEVC2_NATIVE", e.to_string());
                None
            }
        };
        // The run loop owns the timer. A weak view avoids retaining the view
        // after unmount; no libmpv callback ever captures an AppKit object.
        let weak_view = nsh_platform_macos::objc2::rc::Weak::new(&*view);
        let block = RcBlock::new(move |_timer: NonNull<NSTimer>| {
            let Some(view) = weak_view.load() else {
                return;
            };
            let bounds = view.bounds().size;
            let scale = view
                .window()
                .map_or(1.0, |window| window.backingScaleFactor());
            let mut width = (bounds.width * scale).round().max(1.0);
            let mut height = (bounds.height * scale).round().max(1.0);
            let down = (1920.0 / width.max(height)).min(1.0);
            width = (width * down).round().max(1.0);
            height = (height * down).round().max(1.0);
            shared
                .size
                .store(((width as u64) << 32) | height as u64, Ordering::Relaxed);
            let frame = shared
                .frame
                .lock()
                .expect("video frame mutex poisoned")
                .take();
            if let Some(frame) = frame {
                present(&view, frame);
            }
        });
        // SAFETY: scheduled exclusively on the AppKit main run loop. Its block
        // accesses AppKit only on that thread; Drop invalidates it before joining.
        let timer =
            unsafe { NSTimer::timerWithTimeInterval_repeats_block(1.0 / 60.0, true, &block) };
        unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
        Self {
            view,
            timer,
            tx,
            worker,
            source: String::new(),
            cx,
        }
    }
    fn send(&self, request: Request) {
        // Bootstrap/worker failures emit their own specific error once.
        let _ = self.tx.send(request);
    }
}
impl NativeComponent for Video {
    fn view(&self) -> Retained<NSView> {
        Retained::into_super(Retained::into_super(self.view.clone()))
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>) {
        match name {
            "src" => {
                let source = value.and_then(Value::as_str).unwrap_or("");
                if source != self.source {
                    self.view.setImage(None);
                    if !source.is_empty() && !is_service_media(source) {
                        self.source.clear();
                        self.send(Request::Source(String::new()));
                        error(&self.cx, "INVALID_MEDIA", "播放资源不属于当前会话".into());
                        return;
                    }
                    self.source = source.to_owned();
                    self.send(Request::Source(source.to_owned()));
                }
            }
            "paused" => self.send(Request::Pause(
                value.and_then(Value::as_bool).unwrap_or(false),
            )),
            "muted" => self.send(Request::Mute(
                value.and_then(Value::as_bool).unwrap_or(false),
            )),
            "rate" => {
                let rate = value.and_then(Value::as_f64).unwrap_or(1.0);
                if rate.is_finite() && rate > 0.0 {
                    self.send(Request::Rate(rate));
                } else {
                    error(
                        &self.cx,
                        "INVALID_RATE",
                        "Playback rate must be positive".into(),
                    );
                }
            }
            _ => {}
        }
    }
    fn command(&mut self, name: &str, args: &Value) {
        if name == "seek" {
            if let Some(seconds) = args
                .get("seconds")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite() && *s >= 0.0)
            {
                self.send(Request::Seek(seconds));
            } else {
                error(
                    &self.cx,
                    "INVALID_SEEK",
                    "seek.seconds must be nonnegative".into(),
                );
            }
        }
    }
}

fn is_service_media(source: &str) -> bool {
    let Ok(service) = crate::server::connection() else {
        return false;
    };
    source
        .strip_prefix(&format!("{}/media/", service.base_url))
        .is_some_and(|token| {
            token.len() == 64
                && token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
impl Drop for Video {
    fn drop(&mut self) {
        self.timer.invalidate();
        self.send(Request::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn error(cx: &ComponentContext, code: &str, message: String) {
    cx.emit("error", json!({ "code": code, "message": message }));
}
fn present(view: &NSImageView, frame: Frame) {
    // AppKit allocates/owns the destination bitmap; it never references a worker
    // buffer. RGB0 has an unused fourth byte, represented as 24-bit RGB in a
    // 32-bit pixel without alpha.
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(), ptr::null_mut(), frame.width as isize, frame.height as isize,
            8, 3, false, false, NSDeviceRGBColorSpace, frame.stride as isize, 32)
    };
    let Some(rep) = rep else {
        return;
    };
    let pixels = rep.bitmapData();
    if pixels.is_null() {
        return;
    }
    unsafe {
        ptr::copy_nonoverlapping(frame.pixels.as_ptr(), pixels, frame.pixels.len());
    }
    let image = NSImage::initWithSize(
        NSImage::alloc(),
        NSSize::new(frame.width as f64, frame.height as f64),
    );
    image.addRepresentation(&rep);
    view.setImage(Some(&image));
}

// Opaque render context ownership is transferred once to its dedicated thread.
struct Renderer {
    handle: mpv::Handle,
    api: Arc<mpv::Api>,
}
unsafe impl Send for Renderer {}
impl Renderer {
    fn run(self, shared: Arc<Shared>, cx: ComponentContext) {
        let api = &self.api;
        unsafe extern "C" fn update(_: *mut c_void) {}
        unsafe { (api.render_callback)(self.handle, Some(update), ptr::null_mut()) };
        let mut buffer = AlignedBuffer::default();
        let mut previous_size = 0;
        while !shared.stop.load(Ordering::Acquire) {
            let size = shared.size.load(Ordering::Relaxed);
            let width = (size >> 32) as usize;
            let height = (size & 0xffff_ffff) as usize;
            let changed = unsafe { (api.render_update)(self.handle) } & 1 != 0;
            if width > 0 && height > 0 && (changed || size != previous_size) {
                let stride = (width * 4).div_ceil(64) * 64;
                buffer.resize(stride * height);
                let mut dimensions = [width as i32, height as i32];
                let mut stride_param = stride;
                let mut block = 0_i32;
                let mut params = [
                    mpv::Param {
                        kind: 17,
                        data: dimensions.as_mut_ptr().cast(),
                    },
                    mpv::Param {
                        kind: 18,
                        data: c"rgb0".as_ptr().cast_mut().cast(),
                    },
                    mpv::Param {
                        kind: 19,
                        data: (&mut stride_param as *mut usize).cast(),
                    },
                    mpv::Param {
                        kind: 20,
                        data: buffer.ptr.cast(),
                    },
                    mpv::Param {
                        kind: 12,
                        data: (&mut block as *mut i32).cast(),
                    },
                    mpv::Param::end(),
                ];
                let code = unsafe { (api.render)(self.handle, params.as_mut_ptr()) };
                if let Err(message) = api.check(code) {
                    error(&cx, "BYTEVC2_RENDER", message);
                    shared.stop.store(true, Ordering::Release);
                    break;
                }
                let pixels = unsafe { std::slice::from_raw_parts(buffer.ptr, buffer.len) }.to_vec();
                *shared.frame.lock().expect("video frame mutex poisoned") = Some(Frame {
                    width,
                    height,
                    stride,
                    pixels,
                });
                previous_size = size;
            }
            thread::sleep(Duration::from_millis(8));
        }
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        // Callback captures no application data; free synchronizes internal users.
        // This also releases the context if spawning its thread fails.
        unsafe {
            (self.api.render_callback)(self.handle, None, ptr::null_mut());
            (self.api.render_free)(self.handle);
        }
    }
}
#[derive(Default)]
struct AlignedBuffer {
    ptr: *mut u8,
    len: usize,
}
impl AlignedBuffer {
    fn resize(&mut self, len: usize) {
        if self.len == len {
            return;
        }
        self.clear();
        let layout = std::alloc::Layout::from_size_align(len, 64).expect("valid video allocation");
        self.ptr = unsafe { std::alloc::alloc_zeroed(layout) };
        if self.ptr.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        self.len = len;
    }
    fn clear(&mut self) {
        if self.len > 0 {
            unsafe {
                std::alloc::dealloc(
                    self.ptr,
                    std::alloc::Layout::from_size_align_unchecked(self.len, 64),
                )
            };
        }
        self.ptr = ptr::null_mut();
        self.len = 0;
    }
}
impl Drop for AlignedBuffer {
    fn drop(&mut self) {
        self.clear();
    }
}

fn playback(
    rx: mpsc::Receiver<Request>,
    shared: Arc<Shared>,
    cx: &ComponentContext,
) -> Result<(), String> {
    let api = mpv::api()?;
    let core = api.new_core()?;
    let renderer = Renderer {
        handle: core.renderer()?,
        api: api.clone(),
    };
    let render_shared = shared.clone();
    let render_cx = cx.clone();
    let rendering = thread::Builder::new()
        .name("hg-bvc2-render".into())
        .spawn(move || renderer.run(render_shared, render_cx))
        .map_err(|e| e.to_string())?;
    let result = control(&core, rx, cx, &shared);
    shared.stop.store(true, Ordering::Release);
    let _ = rendering.join();
    result
}
fn control(
    core: &mpv::Core,
    rx: mpsc::Receiver<Request>,
    cx: &ComponentContext,
    shared: &Shared,
) -> Result<(), String> {
    let api = &core.api;
    for (id, name) in [(1, c"time-pos"), (2, c"duration")] {
        api.check(unsafe { (api.observe)(core.handle, id, name.as_ptr(), 5) })?;
    }
    let mut duration = 0.0;
    let mut current = 0.0;
    let mut loaded = false;
    let mut paused = false;
    let mut pending_seek = None;
    let mut desired_entry = None;
    let mut active_entry = None;
    let mut last_progress = std::time::Instant::now() - Duration::from_secs(1);
    loop {
        if shared.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        for request in rx.try_iter() {
            let result = match request {
                Request::Shutdown => return Ok(()),
                Request::Source(source) => {
                    loaded = false;
                    duration = 0.0;
                    current = 0.0;
                    pending_seek = None;
                    desired_entry = None;
                    active_entry = None;
                    if source.is_empty() {
                        core.command(&["stop"])
                    } else {
                        core.command(&["loadfile", &source, "replace"])
                            .and_then(|()| {
                                let mut entry = 0_i64;
                                api.check(unsafe {
                                    (api.get)(
                                        core.handle,
                                        c"playlist/0/id".as_ptr(),
                                        4,
                                        (&mut entry as *mut i64).cast(),
                                    )
                                })?;
                                desired_entry = Some(entry);
                                core.set("pause", if paused { "yes" } else { "no" })
                            })
                    }
                }
                Request::Pause(value) => {
                    paused = value;
                    core.set("pause", if value { "yes" } else { "no" })
                }
                Request::Mute(value) => core.set("mute", if value { "yes" } else { "no" }),
                Request::Rate(value) => core.set("speed", &value.to_string()),
                Request::Seek(value) => {
                    if loaded {
                        core.command(&["seek", &value.to_string(), "absolute+exact"])
                    } else {
                        pending_seek = Some(value);
                        Ok(())
                    }
                }
            };
            if let Err(message) = result {
                error(cx, "BYTEVC2_COMMAND", message);
            }
        }
        // Only the control thread touches regular client APIs. It never blocks
        // the independent renderer, including during synchronous seek/load.
        let event = unsafe { &*(api.wait)(core.handle, 0.01) };
        match event.id {
            1 => return Err("libmpv shut down unexpectedly".into()),
            6 if !event.data.is_null() => {
                let start = unsafe { &*event.data.cast::<mpv::StartFile>() };
                active_entry =
                    Some(start.playlist_entry_id).filter(|id| Some(*id) == desired_entry);
            }
            7 if !event.data.is_null() => {
                let end = unsafe { &*event.data.cast::<mpv::EndFile>() };
                if Some(end.playlist_entry_id) != desired_entry {
                    continue;
                }
                loaded = false;
                if end.reason == 0 {
                    cx.emit("end", json!({}));
                } else if end.reason == 4 {
                    let message = api
                        .check(end.error)
                        .err()
                        .unwrap_or_else(|| "Playback failed".into());
                    error(cx, "BYTEVC2_PLAYBACK", message);
                }
            }
            8 if active_entry.is_some() && active_entry == desired_entry => {
                loaded = true;
                if let Some(seconds) = pending_seek.take() {
                    if let Err(message) =
                        core.command(&["seek", &seconds.to_string(), "absolute+exact"])
                    {
                        error(cx, "BYTEVC2_COMMAND", message);
                    }
                }
                let mut value = 0.0_f64;
                if unsafe {
                    (api.get)(
                        core.handle,
                        c"duration".as_ptr(),
                        5,
                        (&mut value as *mut f64).cast(),
                    )
                } >= 0
                {
                    duration = value;
                }
                cx.emit("load", json!({ "duration": duration }));
            }
            22 if !event.data.is_null() => {
                let property = unsafe { &*event.data.cast::<mpv::Property>() };
                if property.format == 5 && !property.data.is_null() {
                    let value = unsafe { *property.data.cast::<f64>() };
                    if !value.is_finite() || value < 0.0 {
                        continue;
                    }
                    if event.userdata == 1 {
                        current = value;
                    }
                    if event.userdata == 2 {
                        duration = value;
                    }
                    if loaded
                        && (event.userdata == 2
                            || last_progress.elapsed() >= Duration::from_millis(200))
                    {
                        last_progress = std::time::Instant::now();
                        cx.emit(
                            "progress",
                            json!({ "currentTime": current, "duration": duration }),
                        );
                    }
                }
            }
            _ => {}
        }
    }
}
