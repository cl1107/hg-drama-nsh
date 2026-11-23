//! 红果 App 上游协议。
//!
//! 这些模块只处理协议字节和响应模型，不负责网络传输、缓存或播放器生命周期。
//! 这样媒体 worker 可以复用同一份签名/片源校验逻辑，也便于离线向量回归。

pub(crate) mod crypto;

pub mod device;
pub mod signature;
pub mod source;
pub mod v5;

pub(crate) use device::DeviceIdentity;

#[path = "../metadata_protocol.rs"]
pub(crate) mod metadata_protocol;
