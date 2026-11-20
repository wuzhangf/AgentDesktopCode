# xagt asset crypto v1 cross-language fixture

This directory is a public, deterministic, test-only interoperability vector
for `xagt-asset-crypto/1`. It contains one AES-256-GCM object and one
`userHeld` X25519/HKDF/Ed25519 content-key envelope. The values are synthetic
and intentionally weak-looking fixed test keys. **Never use any key in this
directory in production, for a real account, or for a real document.**

Implementations should:

1. Encode JSON as UTF-8 with `ensure_ascii=false`, sorted keys, compact
   separators, and no NaN/Infinity values.
2. Use the recorded `objectAadUtf8` for AES-GCM object authentication. The
   object record's `ciphertext` is nonce-independent payload plus the GCM tag;
   the 12-byte nonce is recorded separately.
3. Verify the envelope signature over `envelopeAad || ephemeralPublicKey ||
   sealedKey`, then derive the wrapping key with HKDF-SHA256, no salt, and
   info `xagt.link/user-held/1/` followed by SHA-256 of the canonical binding.
4. Treat `sealedKey` as `nonce(12) || AES-GCM(ciphertext+tag)` and use the
   recorded envelope AAD for its authentication.
5. Require the envelope revision to match the selected conversation revision.

The companion `test_asset_crypto_vectors.py` is the reference positive and
negative check. A conforming mobile implementation should decrypt the object
to `plaintextUtf8`, recover `contentKeyHex` from the envelope, and reject the
wrong recipient, a modified object, and a modified envelope signature.
