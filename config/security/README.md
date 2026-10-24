# Registration password policy

`registration-password-blocklist.json` contains a public common-password corpus, not application credentials or customer data. The existing registration service verifies its SHA-256 before reading it and performs no network call when a user registers.

- Upstream: [SecLists NCSC 100k corpus](https://github.com/danielmiessler/SecLists/blob/a61e8f503c54bf3c399b8f9e4da97e7059a8437e/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt).
- Revision: `a61e8f503c54bf3c399b8f9e4da97e7059a8437e`.
- License: [MIT](https://github.com/danielmiessler/SecLists/blob/a61e8f503c54bf3c399b8f9e4da97e7059a8437e/LICENSE), retained in `SecLists-LICENSE.txt`.
- Normalization: NFC and lowercase, remove empty lines and duplicates; 97,746 unique entries.
- JSON SHA-256: `592df51e9f4a87dc8073e8b17d9f99367ea200fb05620537066a1d4aa6f7a5c6`.
- Reproduce: `node scripts/ops/s24-prepare-password-policy.js` from the backend repository. Review source/version and update the configured checksum deliberately when changing this policy.

The minimum length and bounded scrypt rules remain unchanged. This finite list does not prove that every accepted password is uncompromised. No QA-only policy is used in the normal environment.
