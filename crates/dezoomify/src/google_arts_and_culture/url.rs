use std::fmt::Write;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{KeyInit, Mac, SimpleHmac};
use sha1::Sha1;

use super::tile_info::PageInfo;
use std::ops::Deref;

type HmacSha1 = SimpleHmac<Sha1>;

/// One tile address in the Google Arts signing scheme (x/y/z coordinates).
/// Grouped so `compute_url` calls never carry bare coordinates.
pub struct TileCoord {
    pub x: u32,
    pub y: u32,
    pub z: usize,
}

pub fn compute_url(page: &PageInfo, path: &str, coord: TileCoord) -> String {
    let mut url = format!("{}=x{}-y{}-z{}-t", page.base_url, coord.x, coord.y, coord.z);

    let mut sign_path = path.to_owned();
    write!(sign_path, "=x{}-y{}-z{}-t", coord.x, coord.y, coord.z).unwrap();
    sign_path.push_str(&page.token);

    let digest = mac_digest(sign_path.as_bytes());
    url.push_str(&custom_base64(&digest));
    url
}

fn custom_base64(digest: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest).replace('-', "_")
}

fn mac_digest(b: &[u8]) -> impl Deref<Target = [u8]> {
    let key = &[123, 43, 78, 35, 222, 44, 197, 197];
    let mut mac = HmacSha1::new_from_slice(key).expect("HMac keys can have any length");
    mac.update(b);
    mac.finalize().into_bytes()
}

#[test]
fn test_compute_url() {
    let base_url = "https://lh3.googleusercontent.com/wGcDNN8L-2COcm9toX5BTp6HPxpMPPPuxrMU-ZL-W-nDHW8I_L4R5vlBJ6ITtlmONQ".into();
    let token = "KwCgJ1QIfgprHn0a93x7Q-HhJ04".into();
    let page = PageInfo {
        base_url,
        token,
        name: String::new(),
    };
    let path = page.path().expect("fixture base url has a path");
    assert_eq!(
        compute_url(&page, path, TileCoord { x: 0, y: 0, z: 7 }),
        "https://lh3.googleusercontent.com/wGcDNN8L-2COcm9toX5BTp6HPxpMPPPuxrMU-ZL-W-nDHW8I_L4R5vlBJ6ITtlmONQ=x0-y0-z7-tHeJ3xylnSyyHPGwMZimI4EV3JP8"
    );
}

#[test]
fn test_compute_url_flowers() {
    // From https://artsandculture.google.com/asset/wildflower-painting-of-red-grevillea/wwEzEHEBAqxv4w
    let base_url =
        "https://lh5.ggpht.com/D0sqZ0sJbzoQeYFoySoXLJqgLMfXhi8-gGVGRqD_UEYUqkqk9Eqdxx5NNaw".into();
    let token = "mcOPEQJmk1514hP_dJkpwVwIhPU".into();
    let page = PageInfo {
        base_url,
        token,
        name: String::new(),
    };
    let path = page.path().expect("fixture base url has a path");
    assert_eq!(
        compute_url(&page, path, TileCoord { x: 0, y: 0, z: 7 }),
        "https://lh5.ggpht.com/D0sqZ0sJbzoQeYFoySoXLJqgLMfXhi8-gGVGRqD_UEYUqkqk9Eqdxx5NNaw=x0-y0-z7-tBJ_NeDnzAKjz3ZbOzN_uFRRIbS0"
    );
}
