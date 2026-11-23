use crate::ServiceError;
use reqwest::{
    Client, Response, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
};
use std::{
    io,
    net::IpAddr,
    sync::{Arc, OnceLock},
    time::Duration,
};

struct PublicDns;

impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let mut addresses: Vec<_> =
                tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if addresses.is_empty()
                || addresses
                    .iter()
                    .any(|address| !public_address(address.ip()))
            {
                return Err(
                    io::Error::new(io::ErrorKind::PermissionDenied, "非公网 DNS 目标").into(),
                );
            }
            // Prefer IPv4 as the legacy transport did, while retaining safe IPv6 addresses.
            addresses.sort_by_key(|address| !address.is_ipv4());
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(a == 0
                || a >= 224
                || a == 10
                || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(ip) => {
            // Globally routable unicast, excluding mapped/compatible IPv4 and special local ranges.
            ip.segments()[0] & 0xe000 == 0x2000
        }
    }
}

pub(crate) fn client() -> Result<&'static Client, ServiceError> {
    static CLIENT: OnceLock<Result<Client, ServiceError>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .no_proxy()
                .dns_resolver(Arc::new(PublicDns))
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| ServiceError::new("ERR_NETWORK", "无法初始化 HTTPS 客户端"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn checked_url(raw: &str, domains: &[&str]) -> Result<Url, ServiceError> {
    let url =
        Url::parse(raw).map_err(|_| ServiceError::new("INVALID_RESPONSE", "请求地址格式无效"))?;
    let accepted = url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            domains.iter().any(|domain| {
                host == *domain
                    || host
                        .strip_suffix(domain)
                        .is_some_and(|prefix| prefix.ends_with('.'))
            })
        });
    if accepted {
        Ok(url)
    } else {
        Err(ServiceError::new("SECURITY_BLOCKED", "请求地址不受支持"))
    }
}

pub(crate) async fn read_body(
    mut response: Response,
    limit: usize,
) -> Result<Vec<u8>, ServiceError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ServiceError::new("RESPONSE_TOO_LARGE", "响应超过大小限制"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        ServiceError::new(
            if error.is_timeout() {
                "ETIMEDOUT"
            } else {
                "ERR_NETWORK"
            },
            "读取 HTTPS 响应失败",
        )
    })? {
        if chunk.len() > limit - bytes.len() {
            return Err(ServiceError::new("RESPONSE_TOO_LARGE", "响应超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_local_dns_targets_and_unapproved_origins() {
        for address in [
            "10.1.2.3",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.1.1",
            "::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_address(address.parse().unwrap()));
        }
        for address in ["8.8.8.8", "2001:db8::1"] {
            assert!(public_address(address.parse().unwrap()));
        }
        let allowed = ["fqnovel.com"];
        assert!(checked_url("https://api.fqnovel.com/path", &allowed).is_ok());
        for url in [
            "http://fqnovel.com/",
            "https://a.fqnovel.com.evil.test/",
            "https://a.fqnovel.com:444/",
        ] {
            assert!(checked_url(url, &allowed).is_err());
        }
    }
}
