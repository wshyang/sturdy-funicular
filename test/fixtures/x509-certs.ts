// Test-only X.509 certificates for the key-validator suite.
//
// RSA_CERT_PEM is the repo's committed UAT certificate (a real 2048-bit RSA
// X.509) — it exercises the DER walk that pulls the SubjectPublicKeyInfo out
// of a certificate. EC_CERT_PEM is a throwaway P-256 certificate: structurally
// a valid X.509, but its SPKI carries id-ecPublicKey rather than
// rsaEncryption, which is exactly the case the OID check must reject.
//
// Neither is a secret and neither is used outside the test suite.

export const RSA_CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIDKzCCAhOgAwIBAgIUDSgppW4nN29awbc3UnOC9C3xRQQwDQYJKoZIhvcNAQEL\nBQAwJTEjMCEGA1UEAwwaUFNELUZpcmVmaWdodGVyU3RhdGlvbi1VQVQwHhcNMjYw\nNzIyMDg1NzQ5WhcNMjcwNzIyMDg1NzQ5WjAlMSMwIQYDVQQDDBpQU0QtRmlyZWZp\nZ2h0ZXJTdGF0aW9uLVVBVDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB\nALN4gw7aEQdqWJpX+GvPANqCjTJ1nD+tdLeXglLZUJAqfgKdmywudmgZBWyoUtYL\nc//jqJgk7cKknjW8Fp0TSnS9d4N6VY5h98/vuAUnVIvmjc4ozv1KNQSxc4WDiRqF\nRn1fD5Iq5OXF9dpwbZdfuOiKs9E2b32NQcUO6Xpyo9Zu78gZk/qhOvGCMVzu+SWP\nxFU9Jl4gxzmLxn0/ab1rks/pjC7Lk0DYetOeCKd8tk99FuI/biuVLp34UN20Xq4j\n8cb01r0FUCT65S5X2P44ZXppEOPkd8s34cG7ulxOdBW3gCnyHyV6zqOr+LY2UjJ2\nfB9hNGg2wL7Cahlk6ykTquUCAwEAAaNTMFEwHQYDVR0OBBYEFC/8xQ3yr13Jki0W\ndXtgo6ypAx0cMB8GA1UdIwQYMBaAFC/8xQ3yr13Jki0WdXtgo6ypAx0cMA8GA1Ud\nEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAGbbfGRB82yOtVGZUIKpKPw3\niY88pwcFs57HqnCgP0BGTYNYfQuYWAZ2nOdjuwuaRqt7DGq+6bU9yjmuiuqdFAJL\nRIMkn2OilHtFTj3d+3zGT5GNClkoWqF5E/uOzeHwvTvyHqhnym5qG947sTn8/2RD\n0uiWhjcIDX2yHRuf3lq8AKsfnZx6NWq4j0p8J5BrdGvPVt08zSzhlEg8XTyKZrdt\n8p+VsHWRCHsvTdcAVYgvlnuMV/qJxcMEKOzPGF9ZPM7H+8ofzkrf8+jmrFEbnAi5\nlCGftB5YrMVaUKBvTm0q7m+PyNr/KDgiv9Ur6JoP/x5N/M11djl5ETe590EJDT4=\n-----END CERTIFICATE-----";

export const EC_CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIBejCCAR+gAwIBAgIUGtpzCY7F2hsAmUIOzbVnQMIqixAwCgYIKoZIzj0EAwIw\nEjEQMA4GA1UEAwwHZWMtdGVzdDAeFw0yNjA4MjUwMDEyNTNaFw0yNjA4MjcwMDEy\nNTNaMBIxEDAOBgNVBAMMB2VjLXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC\nAATrB9xzmNcyIaRt7L5aCcpe+64IrZXUKn0shtodEYXarPVItHcrKGub7XL0r+MB\nZDkUJOPGYgFl91JzdXLwgtJho1MwUTAdBgNVHQ4EFgQUEgVFwqI8f+OmE626lWs0\nIpcecgwwHwYDVR0jBBgwFoAUEgVFwqI8f+OmE626lWs0IpcecgwwDwYDVR0TAQH/\nBAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAtDYaCfRQILKpGwbkhFq/mJ+SNZbO\nZ6gN6XGNpvvwJ4cCIQDH2jFc4ORZRhMAApTROKUfG+/UWSnnKYfflMRzxQ1dWA==\n-----END CERTIFICATE-----";
