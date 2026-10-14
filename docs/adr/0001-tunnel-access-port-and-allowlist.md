# Tunnel access is identified by its port and gated by an allowlist

When Tunnel access is on, `orx` opens a second loopback listener, the Tunnel port. Every request that arrives on that listener is treated as Tunnel access. We never decide this from the `Host` header or from proxy headers such as `X-Forwarded-For`.

The reason is that tunnel clients like `cloudflared` and `tailscale serve` connect from 127.0.0.1, so the source address carries no signal. Users also commonly rewrite `Host` to `localhost` to get past the loopback guard. If we classified by `Host`, that misconfiguration would silently give a public URL full, unauthenticated local access. On the original listener we reject any request that carries tunnel proxy headers, so a tunnel aimed at the wrong port fails loudly.

The Tunnel port serves an explicit allowlist of routes:
- read-only browsing
- chat messaging and prompt answers
- creating sessions
- cancelling runs

All other routes are refused. We do not reuse the existing `remote_route_forbidden` denylist because with a denylist, every dangerous route added later would be exposed until someone remembered to block it. The existing denylist already missed the project terminal, the chat `!` shell and absolute-path file reads.

## Considered Options

- **Classify by `Host`:** rejected. It breaks under a common tunnel misconfiguration.
- **Classify by forwarding headers:** rejected. Their presence depends on the tunnel software, and a client can forge them.
- **Extend `remote_route_forbidden`:** rejected because it fails open on new routes.

## Consequences

- Every new route added to the dashboard is unavailable over Tunnel access until it is added to the allowlist on purpose.
- Authentication on the Tunnel port is the real boundary. The allowlist only narrows what a stolen device cookie can reach directly, because an agent driven over chat can still run commands within its permission mode.
