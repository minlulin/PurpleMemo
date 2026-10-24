# Phone share assets

Everything in this folder is embedded into the binary with `include_str!` and
served by `src-tauri/src/share.rs`. None of it is read from disk at runtime.

| File | Served as | Purpose |
|---|---|---|
| `share.html` | `/` | The read-only page. `src/styles/tokens.css` is inlined into it at startup (`/*__TOKENS__*/`). |
| `_snapshot.js` | `/_snapshot.js` | Snapshot decryption. Also imported by `src/lib/phone-page.test.ts`, so the tested code is the code the phone runs. |
| `_crypto/aes.js` | `/_crypto/aes.js` | `@noble/ciphers` — AES-GCM. |
| `_crypto/_polyval.js` | `/_crypto/_polyval.js` | `@noble/ciphers` — GCM's GHASH/POLYVAL. |
| `_crypto/utils.js` | `/_crypto/utils.js` | `@noble/ciphers` — shared helpers. |
| `_crypto/LICENSE` | — | The package's MIT licence. |

## Why the crypto is vendored

`share.rs` used to `include_str!` the three modules straight out of
`node_modules/@noble/ciphers/`, which meant `cargo build` and `cargo test`
failed in a clean checkout that had not run `npm install` — a Rust build
depending on a JavaScript install, for three files that never change between
releases of this app.

## Refreshing the vendored copy

Only when `@noble/ciphers` is upgraded in `package.json`:

```sh
cp node_modules/@noble/ciphers/{aes.js,_polyval.js,utils.js,LICENSE} \
   src-tauri/share/_crypto/
```

Then run `npm test`: `phone-page.test.ts` compares every vendored byte against
the installed package whenever `node_modules` is present, so a forgotten copy is
a failing test rather than a silent divergence. The three files must stay
byte-identical — do not reformat them, or the check (correctly) fails.

The modules import each other with relative paths (`./utils.js`), which is what
lets the same files resolve both as `/_crypto/*` over HTTP and on disk in Node.
