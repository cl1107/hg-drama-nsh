//! The small, dynamically loaded subset of the stable libmpv 2.x C ABI.
//! Definitions follow mpv's include/mpv/{client,render}.h (0.41/0.42).
use libloading::Library;
use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    path::PathBuf,
    ptr,
    sync::{Arc, OnceLock},
};

pub(super) type Handle = *mut c_void;
#[repr(C)]
pub(super) struct Param {
    pub kind: c_int,
    pub data: *mut c_void,
}
impl Param {
    pub fn end() -> Self {
        Self {
            kind: 0,
            data: ptr::null_mut(),
        }
    }
}
#[repr(C)]
pub(super) struct Event {
    pub id: c_int,
    pub error: c_int,
    pub userdata: u64,
    pub data: *mut c_void,
}
#[repr(C)]
pub(super) struct Property {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}
#[repr(C)]
pub(super) struct EndFile {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
}
#[repr(C)]
pub(super) struct StartFile {
    pub playlist_entry_id: i64,
}
#[repr(C)]
union Value {
    string: *mut c_char,
    integer: i64,
    double: f64,
    list: *mut NodeList,
}
#[repr(C)]
struct Node {
    value: Value,
    format: c_int,
}
#[repr(C)]
struct NodeList {
    count: c_int,
    values: *mut Node,
    keys: *mut *mut c_char,
}

pub(super) struct Api {
    // The library outlives every copied function pointer and every mpv object.
    _library: Library,
    pub create: unsafe extern "C" fn() -> Handle,
    pub initialize: unsafe extern "C" fn(Handle) -> c_int,
    pub destroy: unsafe extern "C" fn(Handle),
    pub option: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    pub command: unsafe extern "C" fn(Handle, *const *const c_char) -> c_int,
    pub get: unsafe extern "C" fn(Handle, *const c_char, c_int, *mut c_void) -> c_int,
    pub observe: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    pub wait: unsafe extern "C" fn(Handle, f64) -> *const Event,
    pub error: unsafe extern "C" fn(c_int) -> *const c_char,
    free_node: unsafe extern "C" fn(*mut Node),
    pub render_create: unsafe extern "C" fn(*mut Handle, Handle, *mut Param) -> c_int,
    pub render_update: unsafe extern "C" fn(Handle) -> u64,
    pub render: unsafe extern "C" fn(Handle, *mut Param) -> c_int,
    pub render_callback:
        unsafe extern "C" fn(Handle, Option<unsafe extern "C" fn(*mut c_void)>, *mut c_void),
    pub render_free: unsafe extern "C" fn(Handle),
}

impl Api {
    fn load() -> Result<Arc<Self>, String> {
        let path = if let Some(path) = std::env::var_os("HG_DRAMA_LIBMPV") {
            PathBuf::from(path)
        } else {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            exe.parent()
                .and_then(|p| p.parent())
                .ok_or("Cannot find app Contents directory")?
                .join("Frameworks/libmpv.dylib")
        };
        // SAFETY: the explicit developer override or bundled library must implement
        // the public libmpv ABI. All symbols are checked before calling any of them.
        unsafe {
            let lib =
                Library::new(&path).map_err(|e| format!("Cannot load {}: {e}", path.display()))?;
            let version = lib
                .get::<unsafe extern "C" fn() -> std::ffi::c_ulong>(b"mpv_client_api_version\0")
                .map_err(|e| e.to_string())?();
            if version >> 16 != 2 || version & 0xffff < 3 {
                return Err(format!(
                    "Unsupported libmpv client API {version:#x}; need 2.3+"
                ));
            }
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes())
                        .map_err(|e| e.to_string())?
                };
            }
            Ok(Arc::new(Self {
                create: sym!("mpv_create"),
                initialize: sym!("mpv_initialize"),
                destroy: sym!("mpv_terminate_destroy"),
                option: sym!("mpv_set_option_string"),
                command: sym!("mpv_command"),
                get: sym!("mpv_get_property"),
                observe: sym!("mpv_observe_property"),
                wait: sym!("mpv_wait_event"),
                error: sym!("mpv_error_string"),
                free_node: sym!("mpv_free_node_contents"),
                render_create: sym!("mpv_render_context_create"),
                render_update: sym!("mpv_render_context_update"),
                render: sym!("mpv_render_context_render"),
                render_callback: sym!("mpv_render_context_set_update_callback"),
                render_free: sym!("mpv_render_context_free"),
                _library: lib,
            }))
        }
    }
    pub fn check(&self, code: c_int) -> Result<(), String> {
        if code >= 0 {
            Ok(())
        } else {
            // SAFETY: libmpv returns a process-lifetime string for every error.
            Err(unsafe { CStr::from_ptr((self.error)(code)) }
                .to_string_lossy()
                .into_owned())
        }
    }
    pub fn new_core(self: &Arc<Self>) -> Result<Core, String> {
        // SAFETY: this uniquely owned handle is destroyed by Core, including failures.
        let handle = unsafe { (self.create)() };
        if handle.is_null() {
            return Err("mpv_create failed".into());
        }
        let core = Core {
            api: self.clone(),
            handle,
        };
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("vo", "libmpv"),
            ("hwdec", "no"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("pause", "yes"),
            ("osd-level", "0"),
            ("sub", "no"),
            ("audio-display", "no"),
            ("vd-lavc-dr", "no"),
        ] {
            core.set(name, value)?;
        }
        self.check(unsafe { (self.initialize)(handle) })?;
        Ok(core)
    }
    fn has_bvc2(&self, handle: Handle) -> Result<bool, String> {
        let mut node = Node {
            value: Value { integer: 0 },
            format: 0,
        };
        self.check(unsafe {
            (self.get)(
                handle,
                c"decoder-list".as_ptr(),
                6,
                (&mut node as *mut Node).cast(),
            )
        })?;
        // SAFETY: each union access is guarded by its mpv_format tag. The tree
        // belongs to mpv until free_node, and no pointer escapes this scope.
        let found = unsafe {
            if node.format != 7 {
                false
            } else {
                let list = &*node.value.list;
                (0..list.count).any(|i| {
                    let entry = &*list.values.add(i as usize);
                    if entry.format != 8 {
                        return false;
                    }
                    let map = &*entry.value.list;
                    (0..map.count).any(|j| {
                        let key = CStr::from_ptr(*map.keys.add(j as usize)).to_bytes();
                        let value = &*map.values.add(j as usize);
                        (key == b"codec" || key == b"driver" || key == b"decoder")
                            && value.format == 1
                            && CStr::from_ptr(value.value.string).to_bytes() == b"bvc2"
                    })
                })
            }
        };
        unsafe { (self.free_node)(&mut node) };
        Ok(found)
    }
}

pub(super) struct Core {
    pub api: Arc<Api>,
    pub handle: Handle,
}
impl Core {
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|e| e.to_string())?;
        let value = CString::new(value).map_err(|e| e.to_string())?;
        self.api
            .check(unsafe { (self.api.option)(self.handle, name.as_ptr(), value.as_ptr()) })
    }
    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let strings = args
            .iter()
            .map(|s| CString::new(*s))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut pointers = strings.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
        pointers.push(ptr::null());
        self.api
            .check(unsafe { (self.api.command)(self.handle, pointers.as_ptr()) })
    }
    pub fn renderer(&self) -> Result<Handle, String> {
        let mut render = ptr::null_mut();
        let mut params = [
            Param {
                kind: 1,
                data: c"sw".as_ptr().cast_mut().cast(),
            },
            Param::end(),
        ];
        self.api.check(unsafe {
            (self.api.render_create)(&mut render, self.handle, params.as_mut_ptr())
        })?;
        Ok(render)
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        unsafe { (self.api.destroy)(self.handle) };
    }
}

static API: OnceLock<Result<Arc<Api>, String>> = OnceLock::new();
pub(super) fn api() -> Result<Arc<Api>, String> {
    API.get_or_init(|| {
        let api = Api::load()?;
        let core = api.new_core()?;
        if !api.has_bvc2(core.handle)? {
            return Err("libmpv was built without the Librempeg bvc2 decoder".into());
        }
        let renderer = core.renderer()?;
        unsafe { (api.render_free)(renderer) };
        Ok(api)
    })
    .clone()
}
