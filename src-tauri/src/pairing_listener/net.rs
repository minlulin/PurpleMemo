//! The LAN address a pairing offer advertises in its QR (§11.1, N7): asked of
//! the OS, never configured.

use std::net::UdpSocket;

/// The LAN address a phone on the same network can reach (also the address the
/// pairing offer puts in its QR, §11.1).
///
/// The default route answers on any normal network; an isolated LAN — a phone
/// hotspot or an offline router — has no default route at all, and returning
/// `None` there produced QRs with an empty endpoint that every phone refused
/// (N7). So the routes are asked first and the interfaces second.
pub(super) fn lan_ip() -> Option<String> {
    default_route_ip().or_else(|| pick_lan_ip(interface_ips()))
}

/// The source address the default route would use, when there is one. Binding
/// a UDP socket and "connecting" it sends nothing — it only asks the OS.
fn default_route_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // RFC 5737 TEST-NET: routable-looking, never a real destination.
    socket.connect("192.0.2.1:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

/// The best LAN address among the interfaces the OS reports.
///
/// A private IPv4 address wins (that is what a home network hands out), then
/// any other routable-looking IPv4. Loopback, `169.254/16` link-local and
/// unspecified addresses are never offered: none of them can be dialled from a
/// phone. IPv6 is skipped on purpose — a link-local address needs a scope id a
/// `host:port` QR cannot carry, and the phone's transport dials v4 today.
fn pick_lan_ip(candidates: Vec<std::net::IpAddr>) -> Option<String> {
    use std::net::IpAddr;
    let rank = |ip: &IpAddr| -> Option<u8> {
        match ip {
            IpAddr::V4(v4) if v4.is_loopback() || v4.is_unspecified() => None,
            IpAddr::V4(v4) if v4.is_link_local() => None,
            IpAddr::V4(v4) if v4.is_private() => Some(0),
            IpAddr::V4(_) => Some(1),
            IpAddr::V6(_) => None,
        }
    };
    let mut best: Option<(u8, IpAddr)> = None;
    for ip in candidates {
        let Some(score) = rank(&ip) else { continue };
        let better = match best {
            None => true,
            Some((current, _)) => score < current,
        };
        if better {
            best = Some((score, ip));
        }
    }
    best.map(|(_, ip)| ip.to_string())
}

/// Every IPv4 address the OS reports for its interfaces (no crate needed; the
/// platform call is target-gated here).
#[cfg(unix)]
fn interface_ips() -> Vec<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr};
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: `getifaddrs` fills a NULL-terminated list owned by us; every node
    // is read only while non-NULL, the v4 address is read from the sockaddr the
    // family check just identified, and the list is freed exactly once below.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return Vec::new();
        }
        let mut found = Vec::new();
        let mut cursor = head;
        while let Some(entry) = cursor.as_ref() {
            if !entry.ifa_addr.is_null() && (*entry.ifa_addr).sa_family as i32 == libc::AF_INET {
                let addr = &*(entry.ifa_addr as *const libc::sockaddr_in);
                // `s_addr` is network byte order; its in-memory bytes are the
                // four octets in order.
                found.push(IpAddr::V4(Ipv4Addr::from(
                    addr.sin_addr.s_addr.to_ne_bytes(),
                )));
            }
            cursor = entry.ifa_next;
        }
        libc::freeifaddrs(head);
        found
    }
}

/// Windows: `GetAdaptersAddresses`, the same call every LAN-address crate
/// makes. `windows-sys` is already in the lock file (Tauri's own tree), so this
/// declares an existing pin rather than adding a crate to download.
#[cfg(windows)]
fn interface_ips() -> Vec<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr};
    use std::ptr;
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

    // `usize` keeps the buffer aligned for the adapter structs it is read as.
    let mut words: Vec<usize> = vec![0; 15 * 1024 / std::mem::size_of::<usize>()];
    let mut size = (words.len() * std::mem::size_of::<usize>()) as u32;
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    // SAFETY: the buffer is aligned and sized by `size`, which the call updates
    // on overflow; it is reallocated once and the call repeated.
    let mut result = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            ptr::null(),
            words.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        )
    };
    if result == ERROR_BUFFER_OVERFLOW {
        words = vec![0; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        size = (words.len() * std::mem::size_of::<usize>()) as u32;
        // SAFETY: same contract as the first call, with the size the OS asked
        // for.
        result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                ptr::null(),
                words.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
    }
    if result != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut adapter = words.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    // SAFETY: the adapter list was filled by the successful call above and is
    // NULL-terminated; each unicast entry is likewise walked only while non-NULL
    // and read as a `SOCKADDR_IN` only after its family says it is one.
    unsafe {
        while let Some(current) = adapter.as_ref() {
            let mut unicast = current.FirstUnicastAddress;
            while let Some(entry) = unicast.as_ref() {
                let socket = entry.Address;
                if !socket.lpSockaddr.is_null() && (*socket.lpSockaddr).sa_family == AF_INET {
                    let addr = &*(socket.lpSockaddr as *const SOCKADDR_IN);
                    found.push(IpAddr::V4(Ipv4Addr::from(
                        addr.sin_addr.S_un.S_addr.to_ne_bytes(),
                    )));
                }
                unicast = entry.Next;
            }
            adapter = current.Next;
        }
    }
    found
}

#[cfg(not(any(unix, windows)))]
fn interface_ips() -> Vec<std::net::IpAddr> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    /// The ranking the offer's QR depends on (N7): a phone can dial a private
    /// address, then any other routable-looking IPv4, and nothing else.
    #[test]
    fn pick_lan_ip_prefers_a_dialable_private_address() {
        let private = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let public = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7));
        assert_eq!(
            pick_lan_ip(vec![public, private]),
            Some("192.168.1.20".to_string())
        );
        assert_eq!(pick_lan_ip(vec![public]), Some("203.0.113.7".to_string()));
        assert_eq!(
            pick_lan_ip(vec![
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                IpAddr::V4(Ipv4Addr::new(169, 254, 3, 4)),
                IpAddr::V6(Ipv6Addr::LOCALHOST),
            ]),
            None
        );
    }
}
