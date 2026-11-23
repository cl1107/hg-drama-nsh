use nsh_core::prelude::*;

/// Starts the native companion service for the app window.
#[module]
struct LocalService;

#[module]
impl LocalService {
    /// Starts the in-process loopback service and returns this app instance's connection.
    pub fn connection() -> Result<ServiceConnection, String> {
        server::connection()
    }
}

/// Stable cryptographic primitives exposed to OTA-updatable TSX protocol modules.
#[module]
struct NativeCrypto;

#[module]
impl NativeCrypto {
    /// Encrypts bytes with AES-128-CBC, applying PKCS#7 padding when `pkcs7` is true.
    pub fn aes128_cbc_encrypt(
        key: Vec<u8>,
        iv: Vec<u8>,
        plaintext: Vec<u8>,
        pkcs7: bool,
    ) -> Result<Vec<u8>, String> {
        let key: [u8; 16] = key
            .try_into()
            .map_err(|_| "AES-128 key must be 16 bytes".to_owned())?;
        let iv: [u8; 16] = iv
            .try_into()
            .map_err(|_| "AES-128 IV must be 16 bytes".to_owned())?;
        let input = if pkcs7 {
            upstream::crypto::pkcs7_pad(&plaintext, 16)
        } else {
            if plaintext.len() % 16 != 0 {
                return Err("AES-CBC plaintext must be 16-byte aligned".to_owned());
            }
            plaintext
        };
        Ok(upstream::crypto::aes128_cbc_encrypt(&input, &key, &iv))
    }

    /// Decrypts bytes with AES-128-CBC, removing PKCS#7 padding when `pkcs7` is true.
    pub fn aes128_cbc_decrypt(
        key: Vec<u8>,
        iv: Vec<u8>,
        ciphertext: Vec<u8>,
        pkcs7: bool,
    ) -> Result<Vec<u8>, String> {
        let key: [u8; 16] = key
            .try_into()
            .map_err(|_| "AES-128 key must be 16 bytes".to_owned())?;
        let iv: [u8; 16] = iv
            .try_into()
            .map_err(|_| "AES-128 IV must be 16 bytes".to_owned())?;
        if ciphertext.is_empty() || ciphertext.len() % 16 != 0 {
            return Err("AES-CBC ciphertext must be a non-empty multiple of 16 bytes".to_owned());
        }
        let output = upstream::crypto::aes128_cbc_decrypt(&ciphertext, &key, &iv);
        Ok(if pkcs7 {
            upstream::crypto::pkcs7_unpad(output, 16)
        } else {
            output
        })
    }
}

/// Runtime connection for TSX and the native video player.
#[derive(Clone, JsObject)]
pub struct ServiceConnection {
    pub base_url: String,
    pub token: String,
}

#[native_module("hg-drama/native")]
fn native(registry: &mut Registry) {
    registry.module::<LocalService>();
    registry.module::<NativeCrypto>();
}

#[derive(Clone, Debug)]
pub(crate) struct ServiceError {
    code: &'static str,
    message: String,
}

impl ServiceError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fmt.write_str(&self.message)
    }
}

impl std::error::Error for ServiceError {}

mod auth;
mod catalog;
mod credentials;
mod danmaku;
mod downloads;
mod media;
mod server;
mod transport;
mod upstream;

pub(crate) use upstream::metadata_protocol;

#[cfg(test)]
mod crypto_bridge_tests {
    use super::NativeCrypto;

    #[test]
    fn aes128_cbc_round_trips_with_and_without_pkcs7() {
        let key = vec![0x11_u8; 16];
        let iv = vec![0x22_u8; 16];
        let plain = b"hello-ota-resolver".to_vec();
        let encrypted = NativeCrypto::aes128_cbc_encrypt(key.clone(), iv.clone(), plain.clone(), true)
            .expect("encrypt pkcs7");
        let decrypted = NativeCrypto::aes128_cbc_decrypt(key.clone(), iv.clone(), encrypted, true)
            .expect("decrypt pkcs7");
        assert_eq!(decrypted, plain);

        let aligned = vec![0x33_u8; 32];
        let raw_enc = NativeCrypto::aes128_cbc_encrypt(key.clone(), iv.clone(), aligned.clone(), false)
            .expect("encrypt raw");
        let raw_dec = NativeCrypto::aes128_cbc_decrypt(key, iv, raw_enc, false)
            .expect("decrypt raw");
        assert_eq!(raw_dec, aligned);
    }
}
