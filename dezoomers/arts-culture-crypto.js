const subtle = window.crypto.subtle;

function fromhex(h) {
    return Uint8Array.from(h.match(/[0-9a-fA-F]{2}/g).map(x => parseInt(x, 16)))
}

function tohex(b) {
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

const aes_key_promise = subtle.importKey("raw", fromhex('5b63db113b7af3e0b1435556c8f9530c'), "AES-CBC", true, ["encrypt", "decrypt"]);
const aes_iv = fromhex('71e70405353a778bfa6fbc30321b9592');

const algorithm = { name: "AES-CBC", iv: aes_iv };

// We need a padding because subtle exposes only
// PKCS#7 padded crypto primitives
const pad = (async () => {
    const key = await aes_key_promise;
    const clearpad = new Uint8Array(32).fill(16);
    const buf = await subtle.encrypt(algorithm, key, clearpad);
    return new Uint8Array(buf);
})();

async function aes_decrypt_buffer(buffer) {
    const key = await aes_key_promise;
    // Pad the input
    const c = concat(buffer, await pad);
    const decrypted = await subtle.decrypt(algorithm, key, c);
    // Un-pad the output
    return new Uint8Array(decrypted).slice(0, decrypted.byteLength - 32);
}

function concat(...arrs) {
    const l = arrs.map(a => a.byteLength).reduce((x, y) => x + y, 0);
    const r = new Uint8Array(l);
    for (let i = 0, offset = 0; i < arrs.length; i++) {
        r.set(arrs[i], offset);
        offset += arrs[i].byteLength;
    }
    return r;
}

async function decrypt_image({ buffer }) {
    // The file is composed of a constant header, a body,
    // and a last 4-byte word indicating the start of the encrypted part
    const view = new DataView(buffer);

    // return if the encryption marker isn't present at the start of the file
    if (view.getUint32(0) !== 0x0A0A0A0A) {
        return new Uint8Array(buffer);
    }

    const index = view.getUint32(view.byteLength - 4, true);
    const clear_prefix = new Uint8Array(view.buffer, 4, index);
    const replace_count = view.getUint32(4 + index, true);
    const encrypted = new Uint8Array(view.buffer, 4 + index + 4, replace_count);
    const suffix_start = 4 + index + 4 + replace_count;
    const clear_suffix = new Uint8Array(view.buffer, suffix_start, view.byteLength - suffix_start - 4);
    return concat(clear_prefix, await aes_decrypt_buffer(encrypted), clear_suffix);
}

function make_path(path, token, x, y, z) {
    return path + '=x' + x + '-y' + y + '-z' + z + '-t' + token;
}

function base64_encode(buf) {
    return btoa(String.fromCharCode.apply(null, buf));
}

const hmac_key_promise = subtle.importKey("raw", fromhex('7b2b4e23de2cc5c5'), { name: "HMAC", hash: "SHA-1" }, true, ["sign"]);

async function compute_signed_path(path, token, x, y, z) {
    const sign_path = make_path(path, token, x, y, z);
    const key = await hmac_key_promise;
    const buf = new TextEncoder("utf-8").encode(sign_path);
    const encoded = await subtle.sign("HMAC", key, buf);
    let signature = base64_encode(new Uint8Array(encoded))
        .replace(/\+|\//g, '_')
        .replace(/=/, '');
    return make_path(path, signature, x, y, z);
}
export {
    aes_decrypt_buffer,
    decrypt_image,
    compute_signed_path,
    fromhex, tohex
}