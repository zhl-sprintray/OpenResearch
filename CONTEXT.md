# OpenResearch CLI

`orx` runs research projects, experiments, and coding-agent sessions on the user's own machines; this glossary fixes the words used for how and where the dashboard is reached.

## Language

### Access

**Remote**:
An SSH workspace: `orx` itself runs on another machine and the dashboard reaches it over SSH.
_Avoid_: Using "remote" for a phone or other client reaching a local `orx up`

**Tunnel access**:
Any request that reaches the dashboard through the **Tunnel port**, such as a phone browser going through a tunnel or tailnet. It is defined by the port the request arrives on, never by its Host or forwarding headers.
_Avoid_: Remote access, public access, mobile access

**Tunnel port**:
The second loopback listener that `orx` opens only while Tunnel access is on. The tunnel points at it; every request on it must be authenticated and is subject to Tunnel access restrictions.
_Avoid_: Public port, external port

**Mobile layout**:
The dashboard layout for phone-portrait viewports (narrower than 768px). It depends only on viewport width, not on how the dashboard is reached.
_Avoid_: Mobile mode, mobile app
