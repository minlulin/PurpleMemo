/**
 * Fail-path proof for the OpenSSL symbol check in scripts/check-android-apk.mjs.
 *
 * The broken APK from 97d9398 no longer exists, so the failure the gate must
 * catch cannot be reproduced against a real artefact. These cases pin the
 * verdict instead: the `llvm-readelf --dyn-syms` shape that shipped (undefined
 * `EVP_MAC_fetch` and `CRYPTO_*` references) has to be reported, a clean table
 * has to pass, and the libc symbols a Rust cdylib legitimately leaves to the
 * loader must not be mistaken for it.
 *
 * Run with `node --test scripts/check-android-apk.test.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { opensslSymbols, undefinedSymbols } from "./check-android-apk.mjs";

/** `llvm-readelf --dyn-syms` output, header and rows with the real spacing. */
function readelf(...rows) {
  return [
    "",
    "Symbol table '.dynsym' contains 5 entries:",
    "   Num:    Value          Size Type    Bind   Vis       Ndx Name",
    ...rows,
  ].join("\n");
}

test("a clean symbol table has no undefined OpenSSL symbols", () => {
  const output = readelf(
    "     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT   UND ",
    "     1: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND __cxa_finalize@LIBC",
    "     2: 00000000000a1b2c   128 FUNC    GLOBAL DEFAULT    13 EVP_MAC_fetch",
    "     3: 00000000000a1b40    16 OBJECT  GLOBAL DEFAULT    24 CRYPTO_malloc",
  );

  assert.deepEqual(opensslSymbols(undefinedSymbols(output)), []);
});

test("undefined EVP and CRYPTO symbols are both reported", () => {
  const output = readelf(
    "     1: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND __cxa_atexit@LIBC",
    "     2: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND EVP_MAC_fetch@OPENSSL_3.0.0",
    "     3: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND CRYPTO_malloc@OPENSSL_3.0.0",
    "     4: 0000000000123456    64 FUNC    GLOBAL DEFAULT    13 Java_com_minlulin_purplememo_ReminderBridge_notify",
  );

  assert.deepEqual(opensslSymbols(undefinedSymbols(output)), [
    "EVP_MAC_fetch",
    "CRYPTO_malloc",
  ]);
});

test("libc-style undefined symbols are not a false positive", () => {
  const output = readelf(
    "     1: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND __cxa_finalize@LIBC",
    "     2: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND __cxa_atexit@LIBC",
    "     3: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND memcpy@LIBC",
    "     4: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND strlen@LIBC",
  );
  const names = undefinedSymbols(output);

  assert.equal(names.length, 4);
  assert.deepEqual(opensslSymbols(names), []);
});

test("a versioned OpenSSL reference is reported without its version suffix", () => {
  const output = readelf(
    "     5: 0000000000000000     0 FUNC    GLOBAL DEFAULT   UND OPENSSL_init_crypto@OPENSSL_3.0.0 (4)",
  );

  assert.deepEqual(opensslSymbols(undefinedSymbols(output)), [
    "OPENSSL_init_crypto",
  ]);
});
