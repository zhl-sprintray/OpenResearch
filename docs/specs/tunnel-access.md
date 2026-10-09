# Spec：Tunnel access

> 状态：草稿，待审查。依据是 2026-10-09 的 grilling 讨论（Q1–Q15）。
> 术语沿用 `CONTEXT.md`：**Tunnel access**、**Tunnel port**、**Remote**、**Mobile layout**。
> 相关 ADR：`docs/adr/0001-tunnel-access-port-and-allowlist.md`。
> 姊妹 spec：`docs/specs/mobile-layout.md`。

## Problem Statement

我在电脑上用 `orx up` 或桌面应用跑实验、驱动 agent。离开电脑后，我想用手机继续查看实验，并回应 agent。

但 dashboard 现在只接受 loopback 访问：
- 服务只绑定在 127.0.0.1。
- `loopback_guard` 会拒绝任何非 loopback 的 `Host`，返回 400。

如果我自己用 tunnel 把它暴露出去，就得改写 `Host` 和 `Origin` 来绕过检查，等于亲手拆掉 CSRF 防护。

更严重的是，本机 dashboard **没有任何用户认证**，它的安全全靠"只有本机才连得上"。页面里有终端、shell，还能驱动 agent。一旦 URL 公开，拿到 URL 的人就拿到了我这台机器的 shell。

## Solution

在桌面 dashboard 的设置页里开启 **Tunnel access** 后：
1. orx 检查本机是否已安装并登录 Tailscale。
2. orx 额外开一个 **Tunnel port**，并以子进程方式运行 `tailscale serve`，把 `https://<机器名>.<tailnet>.ts.net` 指向这个端口。
3. 设置页显示这个地址，以及一个"添加设备"的二维码。
4. 用手机扫码完成配对后，手机得到一个设备 cookie，之后就能直接打开这个地址使用 dashboard。在手机上会自动使用 Mobile layout。

经 Tunnel access 只能做这些事：浏览、聊天、回答 agent 的确认和提问、新建会话、取消运行。终端、shell、文件写入和删除、各类设置等能力一律不可用，而且不能放宽 agent 的权限模式。

桌面 dashboard 会常驻显示"Tunnel access 已开启"，能看到已配对设备的列表和每台设备最后活跃的时间，并且可以随时撤销设备或关闭 Tunnel access。

本机访问（127.0.0.1 上的浏览器和桌面应用）完全不受影响。

## User Stories

**开启与关闭**
1. 作为研究者，我想在桌面 dashboard 的设置页里一键开启 Tunnel access，以便不用手动配置 tunnel 和反向代理。
2. 作为研究者，我想用启动参数开启 Tunnel access，以便在命令行启动 `orx up` 时直接带上。
3. 作为研究者，如果没有安装或没有登录 Tailscale，我希望开启时看到明确的原因和安装、登录指引，而不是一个笼统的失败提示。
4. 作为研究者，我希望 orx 不会擅自下载或安装 tunnel 程序，以便我清楚本机运行了哪些第三方二进制。
5. 作为研究者，我希望 Tunnel access 默认关闭，以便只有在我明确操作后才会暴露。
6. 作为研究者，开启后，我希望桌面 dashboard 上一直显示状态标记和关闭入口，以便我随时知道它是开着的。
7. 作为研究者，我希望开启状态在 `orx up` 或桌面应用重启后自动恢复，以便自动更新导致的重启不会切断我在外面的访问。
8. 作为研究者，我想随时关闭 Tunnel access，并且关闭后公网地址立即失效，以便马上收回暴露面。
9. 作为研究者，如果我自己的 Tailscale serve 配置已经占用了 443 端口，我希望 orx 拒绝开启并说明原因，而不是覆盖我的配置。
10. 作为研究者，我希望 orx 退出或崩溃后，Tailscale 里不会残留指向失效端口的映射，以便不用手动清理。
11. 作为研究者，如果已经有另一个 orx 实例开启了 Tunnel access，我希望看到是哪个实例占用了它，以便知道该去哪里关闭。
12. 作为研究者，当 dashboard 连着一台远程机器（Remote）时，我希望 Tunnel access 的开关置灰并附上说明，以便理解为什么现在不能开启。
13. 作为 orx 的开发者，我希望 dev slot 永远不开启 Tunnel access，以便开发环境不会意外暴露出去。

**配对与设备**
14. 作为研究者，我想在桌面 dashboard 上点"添加设备"，生成一个二维码，用手机扫码完成配对，以便不用记密码也不用手动输入任何东西。
15. 作为研究者，我希望配对码 5 分钟内有效并且只能用一次，以便截图或链接外泄后不能被重复使用。
16. 作为研究者，我希望配对码不会出现在服务器日志或 Referer 里，以便它不会通过这些途径泄露。
17. 作为研究者，配对成功后，我希望手机直接进入 dashboard，并在之后免登录访问，以便日常使用没有额外负担。
18. 作为研究者，我希望设备在 30 天内没有使用就自动失效，而每次使用都会续期，以便遗失或不再使用的设备最终会失效。
19. 作为研究者，我希望能在设备列表里看到每台设备的名称、配对时间和最后活跃时间，以便发现异常。
20. 作为研究者，我希望能给设备改名，以便区分自己的手机和平板。
21. 作为研究者，我想逐个撤销设备，被撤销的设备会立即失去访问权，以便应对手机丢失。
22. 作为研究者，我想一键撤销全部设备，以便在怀疑出问题时快速清场。
23. 作为研究者，有新设备配对成功时，我希望桌面 dashboard 弹出提示，以便发现配对被冒用。
24. 作为研究者，关闭 Tunnel access 后再重新开启时，我希望已配对的设备仍然可用，以便不用每次都重新扫码。
25. 作为研究者，在没有有效 cookie 的情况下打开 tunnel 地址，我希望只能看到"请在电脑上发起配对"的页面，以便陌生人连项目名都看不到。

**能力边界**
26. 作为研究者，我想经 Tunnel access 浏览项目、实验、运行、日志和产物，以便在手机上了解进展。
27. 作为研究者，我想经 Tunnel access 阅读会话、发送消息、附加图片、回答权限确认和提问、审批 plan，以便继续推进 agent 的工作。
28. 作为研究者，我想经 Tunnel access 新建会话和取消运行，以便在外面也能安排工作、及时止损。
29. 作为研究者，我希望经 Tunnel access 无法使用终端、`!` shell、SSH 连接、任意路径的文件读取、文件写入和删除、环境变量和 token 设置、项目删除、更新与安装、数据目录迁移，以便 cookie 泄露时能造成的损害尽量小。
30. 作为研究者，我希望经 Tunnel access 无法把会话切换到更宽松的权限模式（比如 bypass permissions），以便 cookie 泄露时 agent 不会被一键放开全部权限。
31. 作为研究者，我希望经 Tunnel access 新建的会话最多只能使用我在本机设定的默认权限模式，以便远程新建的任务不会比本地新建的权限更大。
32. 作为研究者，我希望被禁止的功能在界面上直接不显示入口，而不是点了以后报错，以便界面清晰。
33. 作为研究者，即使我在桌面浏览器里经 tunnel 打开 dashboard，我也希望同样的限制生效，以便安全边界不依赖设备类型。
34. 作为 orx 的开发者，我希望以后新增的任何路由，经 Tunnel access 默认都不可访问，除非明确加进白名单，以便忘记处理时是安全地失败，而不是暴露出去。

**本机访问不受影响**
35. 作为研究者，我希望开启 Tunnel access 后，本机浏览器和桌面应用访问 dashboard 的方式、能力和体验都完全不变，以便日常桌面工作不受打扰。
36. 作为研究者，如果我误把 tunnel 指向了原来的端口，我希望请求被直接拒绝并给出提示，而不是悄悄获得完整权限，以便配置错误时能被发现，而不会变成安全事故。

## Implementation Decisions

**两个监听端口**
- Tunnel access 开启后，`orx up` 在**第二个监听端口**（Tunnel port）上提供服务。它同样绑定 127.0.0.1，端口每次启动时随机分配。
- 两个监听端口共享同一个应用状态（store、ChatHost、事件流），只是中间件不同。
- 是否为 Tunnel access，**只看请求从哪个端口进来**，不看 Host、源地址或代理请求头。理由见 ADR 0001。
- 原端口的中间件栈保持现有的 `loopback_guard`，再增加一条规则：请求里如果带有 tunnel 代理会加的头（`X-Forwarded-For`、`X-Forwarded-Host`、`Forwarded`、`Cf-Connecting-Ip`、`Tailscale-User-Login` 等），直接拒绝，并在错误信息里说明"tunnel 应该指向 Tunnel port"。
  - 需要先核实：Vite dev 代理、桌面应用 webview、Remote gateway 这三类本机内部的转发请求，有没有带这些头，避免误伤。
- Tunnel port 的中间件栈（由外到内）：
  1. 安全响应头，沿用 `secure_response` 的那一套。
  2. **Origin 校验**：对非幂等请求和 WebSocket 请求，Origin 必须等于当前 tunnel 地址（https）。
  3. **设备认证**：验证设备 cookie；没有通过的请求只能访问配对页、配对接口和静态资源。
  4. **路由白名单**：不在白名单里的路由，返回 403。
  5. 请求上下文里打上 Tunnel access 标记，供后面的处理函数使用（例如权限模式的限制）。

**路由白名单**（按能力分组；具体路由在实现时逐条列出，并配一个"所有路由都已经归类"的测试）
- **浏览（只读）**：
  - 项目列表、实验、运行、运行日志
  - 产物列表和产物内容
  - 会话列表和消息
  - 事件流 SSE
  - 技能列表，以及新会话页需要的 harness 和模型信息
  - runtime 信息
- **聊天**：
  - 发送消息（含图片附件）、steer、中断
  - 回答 prompt
  - 新建会话
- **运行**：取消运行。
- **配对**：配对页、兑换配对码的接口。
- 其余一律拒绝。现有 `remote_route_forbidden` 清单里的路由，以及终端、`!` shell、`/api/files/abs*`、文件写入和删除、环境变量和 token 设置、SSH connect、Overleaf session 导入、项目删除，都不在白名单里。

**权限模式限制**
- 经 Tunnel access 修改会话的权限模式或 plan 模式时，只允许改成**同样或更严格**的模式。
- 新建会话时，权限模式不能比本机设定的默认值更宽松。
- 这条限制在聊天层的处理函数里执行，依据请求上下文里的 Tunnel access 标记。

**配对与设备会话**
- **生成配对码**：桌面 dashboard 只能经原端口调用"生成配对码"接口。配对码随机生成，5 分钟有效，只能使用一次，只保存在内存中。
- **配对链接**：形如 `https://<tunnel 地址>/pair#<配对码>`。配对页上的脚本从 `#` 片段里读出配对码，POST 给兑换接口，因此配对码不会出现在请求行、服务器日志和 Referer 中。
- **兑换**：成功后服务端生成一个随机的设备 token，用 `Set-Cookie` 下发，属性是 `HttpOnly; Secure; SameSite=Strict; Path=/`，然后跳转到首页。
- **持久化**：本地 SQLite 新增一张设备表，字段包括 id、名称（根据 User-Agent 自动生成，可以修改）、token 的哈希值、配对时间、最后活跃时间。
- **有效期**：滑动 30 天。最后活跃时间按分钟级节流写入。
- **撤销**：删除设备记录后立即生效；已经建立的 SSE 和 WebSocket 连接会被关闭。
- **关闭 Tunnel access 时**：保留设备记录。
- **管理接口**：设备列表、改名、撤销、撤销全部，都只能经原端口访问。
- **新设备提示**：配对成功时，通过事件流通知桌面 dashboard，弹出提示。

**Tunnel provider**
- 定义一个 provider 抽象，包含这些能力：检测是否可用（已安装、已登录、端口是否冲突）、启动（返回公网地址）、停止。
- 第一期只实现 **Tailscale serve**：
  - 以前台子进程方式运行 `tailscale serve`，不加 `--bg`，子进程随 orx 一起退出，不在全局配置里留下残留。
  - 公网地址从 `tailscale status` 里取得的 MagicDNS 名称推导出来。
  - 启动前读取现有的 serve 配置；如果 443 已被用户自己的配置占用，就拒绝开启。
  - 子进程意外退出时，在 UI 上显示为"tunnel 已断开"，并按退避策略重启。
- 不自动下载任何二进制。检测失败时，给出可操作的安装和登录指引。

**开启状态与生命周期**
- 开启状态写入 orx 的配置文件，`orx up` 和桌面应用启动时读取并自动恢复。
- `orx up` 新增一个启动参数，用来临时覆盖配置。
- **单实例约束**：开启 Tunnel access 时要获取一把锁，可以沿用或扩展现有的 dashboard 锁机制。拿不到锁时报错，并指出占用锁的实例。dev slot 启动时强制关闭 Tunnel access。
- **与 Remote 的关系**：dashboard 处于 Remote 模式时，不允许开启 Tunnel access。

**桌面端 UI**
- 设置页新增 "Tunnel access" 区域，包括：开关、provider 状态（未安装 / 未登录 / 已就绪 / 已连接 / 已断开）、公网地址、"添加设备"二维码、设备列表（改名、撤销、撤销全部）。
- 开启后，在主界面常驻显示一个状态标记，点击跳转到上面这个区域。

**UI 能力感知**
- runtime 信息接口新增一个字段，告诉前端当前请求是否经由 Tunnel access。
- 前端据此隐藏被白名单拒绝的入口。这只是为了界面合适，安全由服务端保证。
- 这个能力判断和 Mobile layout 的宽度判断相互独立，可以任意组合。

**PWA 与 cookie**
- 设备 cookie 是 `Secure` 的，要求必须经 https 访问，Tailscale serve 已经满足这一点。
- Mobile layout 的 spec 里会加入 web app manifest。添加到主屏幕后打开的 PWA 能否与浏览器共享 cookie，iOS 上的行为需要实测，见下文 Further Notes。

## Testing Decisions

**什么是好测试**
- 从 HTTP 层面验证外部行为：给定"从哪个端口进来、带什么 cookie、Origin 和请求头是什么"，期望得到什么状态码和响应。
- 不测中间件内部是怎么实现的。

**测试接缝**（尽量少，并且放在尽可能高的层级）
1. **Tunnel port 路由层**（主接缝）：在测试里构建 Tunnel port 的完整 router（中间件栈加真实路由），起一个 127.0.0.1:0 的服务，用 loopback client 发请求。覆盖：
   - 没有 cookie 时，只能访问配对页、兑换接口和静态资源。
   - 配对码在 5 分钟内有效，只能使用一次，过期或重复使用都会失败。
   - cookie 有效时，白名单内的路由放行，白名单外的路由返回 403，包括终端 WebSocket、`!` shell、`/api/files/abs`、写文件、设置环境变量。
   - Origin 不匹配时，非幂等请求和 WebSocket 请求被拒绝。
   - 设备被撤销后，请求立即失败。
   - 经 Tunnel access 把权限模式改得更宽松会被拒绝，改得更严格可以成功。
   - **白名单完整性**：遍历 router 上注册的所有路由，每一条都必须被明确归类为"放行"或"拒绝"，新增路由如果没有归类，测试就失败。
   - 先例：`up.rs` 测试模块中"起一个 127.0.0.1:0 的 axum 服务，再用 `loopback_client` 发请求"的写法，以及 `up_remote.rs` 里 `loopback_hosts_are_narrow` 等关于 guard 的测试。
2. **原端口路由层**：带有 tunnel 代理请求头的请求被拒绝；不带这些头的本机请求，行为与现在一致。复用接缝 1 的测试工具。
3. **Tunnel provider**：用一个假的 provider 实现来测试开启和关闭的状态机，包括"未安装、未登录、端口冲突、子进程退出后重启、单实例锁冲突、Remote 模式下不允许开启"。真实的 Tailscale 调用不进 CI，只做手动验收。
4. **设备存储**：设备的增删改查、只保存哈希值、滑动过期，放在 store 现有的测试模块里。

**CI**
- 按 `.github/workflows/ci.yml` 的要求，通过 `fmt`、`clippy`、`test`。
- UI 改动需要执行 `pnpm build`，并提交 `ui/dist`。

## Out of Scope

- Cloudflare（quick tunnel 和 named tunnel）以及其他 tunnel 服务。第一期只预留 provider 接口。
- Tailscale funnel（公网可达）。第一期只用 serve；不过按 Q1，安全设计已经按公网可达来做。
- 自动下载或安装 tunnel 程序。
- Remote（SSH workspace）模式下的 Tunnel access。
- 账号体系：openresearch.sh 登录、多用户、团队共享。
- 推送通知、service worker。
- Tunnel access 的独立操作审计日志。会话记录本身已经包含所有操作。
- Mobile layout 本身（见姊妹 spec）。

## Further Notes

- **剩余风险**：经 Tunnel access 能驱动 agent，而 agent 在它当前的权限模式内可以执行命令。白名单和权限模式限制只能缩小 cookie 泄露后的损害，**设备认证才是真正的边界**。ADR 0001 已经写明这一点。
- **需要实测的点**：
  - iOS 上，"添加到主屏幕"后打开的 PWA 与 Safari 不共享 cookie。PWA 里可能需要单独配对一次，配对页要能在 PWA 内完成。
  - Tailscale serve 以前台模式运行时，`tailscale` CLI 的版本差异（参数格式、读取配置的方式）。
  - 现有本机内部的转发链路有没有带代理请求头：Vite dev 代理在开启 `changeOrigin` 时可能加 `X-Forwarded-*`，Remote gateway 的 `proxy_request` 会剥离这些头。要先核实，避免新增的拒绝规则误伤。
- **调研事实**：
  - 浏览器端目前不发送任何认证信息；现有 Remote 模式的 Bearer 是本机 gateway 在服务端添加的。
  - 代码库里没有设备、配对、cookie 认证这类机制。
  - `same_origin` 接受 https，但 `loopback_guard` 的 Origin 检查只接受 http。
- **安全审查**：上线前建议用 `/security-review` 审一遍中间件栈和白名单。
