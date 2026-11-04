# Security

This application is a remote control for a desktop agent environment. Its threat model is different from a standalone chat client.

## Trust boundaries

- **Desktop owner:** controls the bridge, local filesystem, Host grants and installed team tools. Other native processes running as the same user are not sandboxed by this project.
- **Paired device:** holds a credential that permits operations through the bridge. Pairing is an access grant, not merely a notification subscription.
- **Relay operator:** can inspect and route forwarded JSON. TLS is used on each connection; the protocol is not end-to-end encrypted.
- **Host and plugins:** determine the supported tools and hosted-agent behavior. A successful build is not proof of compatibility with every Host release.
- **Release signer:** controls Android update identity. An unknown or changed certificate must not be accepted just to make installation succeed.

The bridge's local HTTP surface requires loopback addressing and a same-origin session secret for mutations. These browser-facing defenses do not authenticate arbitrary native processes on the same machine.

## Handling credentials

Keep relay signing secrets, bridge and device credentials, signing keystores and passwords outside source control. Do not place secrets in `EXPO_PUBLIC_*` variables: those values are embedded in the client bundle.

A leaked relay signing secret compromises credentials for every account using that secret. Replace the secret and re-enroll affected desktops and devices. A leaked device credential should be revoked by the desktop owner. If a desktop credential is compromised, use the relay's bridge-revocation mechanism and provision a replacement.

Native credentials use SecureStore; this does not encrypt every piece of application data. Queued, failed and uncertain operation recovery records are stored in AsyncStorage, including message text. They inherit the platform's app-storage protections and are not application-layer encrypted. Web profiles also hold credentials in plaintext browser storage. Android's generated backup rules must be inspected separately from credential storage; an enabled backup flag alone does not establish which files are selected.

Do not include raw pairing codes, bearer tokens, private keys, conversation transcripts or desktop configuration files in bug reports. Redact both screenshots and machine-readable logs.

## Reporting a vulnerability

Do not disclose an unpatched vulnerability or sensitive reproduction data in a public issue.

If the repository's Security tab offers private vulnerability reporting, use it. Otherwise, open an issue requesting a private reporting channel without including exploit details or credentials. No email address or private-reporting feature is assumed to exist.

A useful private report names the affected revision and component, preconditions, expected boundary, minimal reproduction and observed result. Clearly distinguish local test doubles from device behavior or a real deployed service.

## Validation limits

Unit tests, dependency scans, builds and certificate checks cover different risks; none replaces the others. Changes to authentication, storage, delivery, native configuration or Host integration require targeted regressions and integration checks. Real Cloudflare upgrades, device lifecycle behavior, screen-reader output and release signing need validation in their respective environments.

Replay and operation deduplication are bounded. The protocol does not promise durable exactly-once execution. A timeout can leave an operation's remote outcome uncertain; do not retry a potentially destructive action blindly.
