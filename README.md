# toSub2

QQ 交流群：`1085165735`

[点击链接加入群聊【toSub2】](https://qm.qq.com/q/n40xuIClm8)

toSub2 是一个本地网页工具，通过协议请求完成 ChatGPT 登录和 Codex OAuth（授权登录），自动判断账号是否需要绑定手机号，并生成可供 sub2api 导入的 JSON（结构化数据）文件。

> 本项目不是 OpenAI 官方项目。上游登录接口随时可能变化。

## 工作流程

1. 通过邮箱验证码或密码登录 ChatGPT。
2. 账号启用 2FA（双重身份验证）时，自动生成并提交 TOTP（基于时间的一次性密码）。
3. 发起 Codex OAuth（授权登录）。
4. 根据服务端响应判断账号是否已经绑定手机号。
5. 未绑定手机号时进入短信验证，支持手动号码、LubanSMS（鲁班接码）、SMSBower（短信接码平台）或自定义接码 API（接口）。
6. 选择 workspace（工作区），兑换 OAuth Token（授权令牌）。
7. 生成标准 `sub2api-data` 导入文件。

## 主要功能

- 本地网页控制台，可同时管理多条登录任务。
- 最多同时运行 20 条任务，超出后自动排队。
- 支持手动邮箱验证码、邮箱收码 API（接口）自动取码。
- 支持密码登录，以及密码或邮箱验证码登录后的 2FA（双重身份验证）。
- 已完成 ChatGPT 登录的账号可以单个或批量创建新的 TOTP 2FA（基于时间的一次性密码），不要求先完成手机号绑定或 Codex 授权；程序会自动生成并提交激活验证码，密钥不会写入协议日志，设置完成后可继续原授权流程。
- 无密码账号可以单个或批量添加随机强密码，已有密码的账号会自动跳过；支持邮箱 API 自动收码或手动输入验证码，成功后会更新本地账号原始信息。账号只要已保存邮箱登录检查点即可添加密码，不要求先完成手机号绑定或 Codex 授权；添加后可继续原授权流程。
- 自动跳过已经完成手机号绑定的账号。
- 未绑定账号支持手动手机号、手动短信验证码，以及 LubanSMS、SMSBower、自定义号码池自动取号收码。
- 邮箱登录成功后立即保存 checkpoint（检查点），中断后可继续手机号流程。
- 支持单个和批量重新授权；“重新授权”优先使用已有 Refresh Token（刷新令牌），“重新登录并授权”会跳过刷新令牌和旧检查点，强制重新完成登录与授权。
- 支持分页、精确筛选、跨页多选、批量删除、停止全部、批量重新授权和批量下载。
- 可每 5 分钟巡检 Sub2API 异常账号，对上次全自动登录的任务自动重新登录并更新远端授权。
- 可将选中的已完成账号直接同步到 CPAMP；同邮箱会更新已有授权而不是重复创建，远端的优先级、代理、备注、启用状态等配置会保留。
- 可选择只自动同步启用后新完成的任务；每个邮箱首次自动外发前均需要在本地页面明确确认。
- 最终输出 sub2api 导入格式，下载文件名自动附带时间戳。

## 环境要求

- Node.js 20 或更高版本，建议使用 Node.js 22。
- Python 3.9 或更高版本；默认协议登录流程需要安装 `curl_cffi`（浏览器 TLS 指纹请求库），即使不使用代理也需要。
- macOS 使用 Keychain（钥匙串）持久保存密码、2FA 密钥和账号代理。
- Windows 使用当前用户的 DPAPI（数据保护接口）加密保存上述数据，密文位于 `%LOCALAPPDATA%\toSub2\credentials`，只能由同一个 Windows 用户解密。
- Linux 仍可使用邮箱验证码流程，但目前不持久保存密码、2FA 密钥和账号代理；服务重启后不会让原本配置代理的排队任务悄悄改用本机网络。

## 安装与启动

```bash
git clone git@github.com:jackgodcs/AuthTo.git
cd toSub2
npm ci
python -m pip install -r requirements.txt
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:4399
```

### Windows 便携安装

Windows 上可以将项目放在任意目录（例如 `D:\Program Files\toSub2`）。可以使用系统 Python，也可以将一个可用的 Python 运行时放到项目内的 `python` 目录。安装依赖后可双击 `启动.cmd`，关闭时双击 `关闭.cmd`：

```powershell
npm ci
python -m pip install -r requirements.txt
```

若使用项目内运行时，第二条命令替换为 `.\python\python.exe -m pip install -r requirements.txt`。启动脚本会优先使用内置运行时，找不到时自动使用系统 `python` 或 `py`。运行数据、日志和加密凭据都位于当前 Windows 用户的 `%LOCALAPPDATA%\toSub2`，不会写入源码目录。它会优先使用 `D:\Program Files\PowerShell-7.5.3-win-x64\pwsh.exe`，并将此路径传给程序以保存 CPAMP 管理密钥。

指定其他端口：

```bash
npm run dev -- --port 4400
```

允许局域网设备访问：

```bash
npm run dev -- --host 0.0.0.0
```

局域网模式没有访问认证，只应在可信网络内短时间使用。

### PM2（Node.js 进程管理器）守护运行

号池巡检依赖控制台服务持续运行。需要崩溃后自动重启或开机启动时，建议使用项目内置的 PM2 配置：

```bash
npm install -g pm2
npm run daemon:start
pm2 save
pm2 startup
```

`pm2 startup`（生成开机启动配置）会输出一条系统命令，继续执行该命令即可。默认使用 `127.0.0.1:4399` 和项目内的 `tmp/chatgpt-onboarding-console` 数据目录。

需要保留旧数据目录并开放局域网时，macOS/Linux 可以在首次启动时传入：

```bash
ONBOARDING_OUTPUT_ROOT=/path/to/existing-data ONBOARDING_HOST=0.0.0.0 npm run daemon:start
```

Windows PowerShell（命令行）使用：

```powershell
$env:ONBOARDING_OUTPUT_ROOT="C:\path\to\existing-data"
$env:ONBOARDING_HOST="0.0.0.0"
npm run daemon:start
```

常用管理命令：

```bash
npm run daemon:restart
npm run daemon:logs
npm run daemon:stop
```

PM2 只负责在进程异常退出后重启。toSub2 在正常关闭时仍会先取消巡检请求、停止登录任务并保存任务状态。

## 账号代理和 TLS 指纹

网页顶部的“代理 IP”输入框配置账号登录使用的代理。支持以下格式：

```text
http://用户名:密码@主机:端口
socks5h://用户名:密码@主机:端口
socks5h://account-id:proxy-secret-JP-91977332-20m@proxy.example.com:1000
```

如果用户名中存在 `-sid-xxxxxxxx-t-20`，或者密码中存在 `-JP-12345678-20m` 这样的会话字段，toSub2 会为每个任务随机生成新的会话编号，并使用 `curl_cffi` 的 Chrome 浏览器 TLS 指纹真实访问 `chatgpt.com` 检测出口。未配置代理时默认直接使用 `chrome146`，不在正常任务启动前筛选指纹；如果遇到 Cloudflare（云防护平台）挑战，会优先使用本地求解器处理，只有求解失败时才启动一次共享的直连 TLS 指纹筛选作为兜底，然后用筛选出的指纹重试当前任务。通过 `--tls-profile` 或 `TOSUB2_TLS_PROFILE` 显式指定时使用指定指纹，也可以显式指定 `auto` 才启用指纹探测。如果当前 Python `curl_cffi` 或底层库不支持指定指纹，会自动降级到兼容指纹，并把实际降级结果同步给后续流程。协议请求的 User-Agent、Client Hints、OAuth 请求头以及补充账号资料时的 Sentinel 浏览器环境都会跟随最终指纹版本，不再混用固定版本或不同操作系统环境。HTTP 风控响应会更换会话，最多使用 10 个有响应的代理会话；TLS、超时等纯连接失败不占这 10 次，但连续连接失败达到 20 次也会停止，避免网络异常时无限循环。代理检测通过后，如果在邮箱登录、2FA、手机号绑定、工作区选择或 OAuth（授权登录）阶段再次遇到 403 HTML 风控页，任务会清除本次无效登录状态、换新代理会话并从当前流程起点自动重试。没有可识别会话字段的固定代理不会重复轮换，失败后直接提示用户更换代理。

代理首次检测通过后，正式登录和授权流程如果再次遇到明确的安全校验页面，会先保持当前代理出口重试最多 3 次；手机号验证码发送接口只有在 `400/409` 同时带有安全校验响应头或实际安全校验页面时才采用相同策略。连续 3 次重试后仍然触发风控，才会进入更换代理并重新授权流程。普通手机号不可用、`invalid_state` JSON 等业务错误不会触发代理重试，只提示用户更换当前手机号。

当响应包含可执行的 Cloudflare（云防护平台）挑战配置时，toSub2 会优先在当前 `curl_cffi` Session（会话）中运行父挑战和 Turnstile（人机验证）子挑战。获得 `cf_clearance` 后会使用同一代理出口、同一 TLS 指纹和同一 Cookie 会话重放原请求。只有挑战无法完成或重放后仍被拦截时，才进入上述同出口重试和随机会话编号兜底。该运行环境依赖 `jsdom`（网页环境模拟器），执行 `npm install` 时会自动安装。

Sentinel（动态安全令牌）不再使用项目内置的静态 PoW/DX 生成器。每个登录会话会实时下载 Sentinel 加载器和当前版本 SDK，在独立的 `jsdom` 父页面和 iframe（内嵌页面）中执行，并由当前 Python `curl_cffi` Session 提交 SDK 产生的请求。生成过程复用账号当前代理、Cookie、设备 ID、TLS 指纹、User-Agent 和平台语言信息；代理会话或 `sid` 更换后会销毁旧 Sentinel 运行时并重新初始化。最终按服务端要求生成 `OpenAI-Sentinel-Token`，存在 Session Observer（会话观察器）数据时同时生成 `OpenAI-Sentinel-SO-Token`。

代理输入为空时使用本机网络。页面设置保存在当前浏览器的 localStorage（本地存储）中；创建任务、重试和重新授权会读取输入框当前最新内容。任务实际使用的代理还会保存在系统安全凭据存储中，以便服务重启后恢复排队任务。代理密码不会写入 `job-meta.json`（任务元数据）或日志。

Python 辅助进程默认使用 `python3`（macOS/Linux）或 `python`/`py -3`（Windows）。如果系统有多个 Python，可以设置环境变量 `TOSUB2_PYTHON` 指定解释器路径。

## 批量添加格式

每行一个账号。toSub2 会根据字段特征自动识别邮箱、密码、邮件接收 API 和 2FA 密钥，字段顺序不固定。现有 `----` 格式仍完全兼容：

```text
邮箱
邮箱----邮箱收码接口
邮箱----密码
邮箱----密码----2FA身份验证密钥
邮箱----密码----邮件接收API
邮箱----密码----邮件接收API----2FA身份验证密钥
邮箱----邮箱收码接口----2FA身份验证密钥
邮箱--------2FA身份验证密钥
```

示例：

```text
name@example.com
name2@example.com----https://mail.example/messages/account-token
name3@example.com----账号密码----JBSWY3DPEHPK3PXP
name4@example.com----账号密码----https://mail.example/messages/name4
name5@example.com----账号密码----https://mail.example/messages/name5----JBSWY3DPEHPK3PXP
name6@example.com----https://mail.example/messages/account-token----JBSWY3DPEHPK3PXP
name7@example.com--------JBSWY3DPEHPK3PXP
```

也可使用 `|`、Tab（制表符）、`::`、逗号、分号或连续空格分隔，例如：

```text
https://mail.example/messages/name|JBSWY3DPEHPK3PXP|账号密码|name@example.co.uk
JBSWY3DPEHPK3PXP::name+tag@example.dev::账号密码
```

解析器会先确定完整 URL（网址）、独立邮箱和 Base32（基础三十二进制）2FA 密钥，然后根据它们的边界推断分隔符，将剩余原文作为密码。因此密码内包含 `|` 等字符时也会尽量完整保留。邮箱中的合法短横线也会尽量合并回完整邮箱，不会直接把邮箱前半部分当成密码。如果一行存在多种可能的拆分方式、多个完整邮箱、URL 中的逗号或分号可能被当成字段分隔符，会明确报错并提示改用 `----`，不会静默猜测。仅有邮箱和 2FA 密钥的账号继续使用 `邮箱--------2FA密钥` 表示空密码；`邮箱----密码--------2FA密钥` 也会正确识别密码和 2FA。仅有邮箱、一个 Base32 字段和邮件 API 时，Base32 字段在 API 之前按密码保留，在 API 之后按 2FA 密钥处理；如果同时还有另一个普通字段，则 Base32 字段按 2FA。单独出现的 `http://` 或 `https://` 字段按邮件 API 处理，不支持自动区分“网址形式的密码”。邮箱支持多级域名及点、短横线、下划线、加号等常见前缀，不限制为 `.com` 后缀。邮箱是唯一字段，重复导入会更新原任务资料。

## 接码平台配置

网页顶部的“接码平台”区域可以打开统一配置页面。每个平台拥有独立配置，保存后写入当前浏览器的 localStorage（本地存储）；服务端不会持久保存 API Key（接口密钥）。

目前支持：

- LubanSMS：填写 API Key 和供应商编号。
- SMSBower：填写 API Key 后手动点击“查询价格”，再从下拉框选择国家。列表按价格从低到高显示中文国家名称、价格和库存，不显示国家缩写和国际区号。
- 自定义接码：每行填写 `+国际手机号----接码API`，一次最多 500 条。重复手机号以最后一行为准，并发任务按顺序获取未分配号码。

```text
+8613711111111----https://example.com/messages/13711111111
+8613822222222----https://example.com/messages/13822222222
```

任务到达手机号步骤后，可以使用当前选中的平台取号。SMSBower 取号时会带上用户选择时的最高价格，避免实时价格上涨后按更高价格购买。自定义接码在发送短信前会先记录接口中的旧验证码，只提交之后出现的新验证码。服务端会自动轮询短信、提取独立的 6 位数字验证码并提交。手动手机号和手动验证码流程始终保留。

新增平台时，通过统一 SmsProvider（短信平台适配器）接入，不需要复制任务轮询和状态处理代码。

API Key 只会随取号请求临时发送给本地服务，不会写入任务元数据、协议日志或导出文件。

## 直接上传到 Sub2API

任务完成后，可以在单个任务的“上传”按钮，或顶部批量操作中使用“上传到 Sub2API”，把生成的 OAuth（授权）账号直接写入指定的 Sub2API 后端号池。

首次使用时，在页面的“Sub2API”配置区域填写：

- Sub2API 后端地址，例如 `http://127.0.0.1:8080`。
- 管理员 API Key（管理员接口密钥）。请求时通过 `x-api-key` 请求头发送。
- 点击“读取配置”后读取目标号池和代理列表。号池支持多选；不选择具体分组时使用后端默认号池。
- 可以统一指定代理 IP、并发数、负载因子和优先级。数字参数留空时保留每个账号原来的配置。
- 可以填写允许使用的模型，每行一个，也支持逗号分隔，例如 `gpt-5`、`gpt-5-mini`。

上传选项会保存在当前浏览器的 `localStorage`（本地存储）。批量上传时，未完成的任务会自动跳过；服务端返回的创建失败数量会显示在控制台中。

### Sub2API 号池监控

在 Sub2API 配置中启用“每 5 分钟监控异常账号”后，本机服务会按页读取 `openai` 平台中状态为 `error` 的账号，提取邮箱并匹配本地任务。如果配置了号池，只检查所选号池；没有选择时检查全部 OpenAI 账号。

只有同时满足以下条件的任务才会自动重新登录并授权：

- 上次完整登录已成功，且密码、邮箱验证码、登录 2FA 均未由用户手动输入。
- 上次用到的密码和 2FA 密钥仍能从系统凭据存储读取，邮箱收码 API 仍存在。
- 任务当前没有运行、排队或执行其他操作。

手动输入绑定手机号或手机验证码不影响自动修复资格，因为账号通常只需绑定一次。自动授权成功后，toSub2 会按 Sub2API 远端账号 ID 更新凭据，不会通过批量创建接口新增重复账号；远端的模型映射等非敏感配置会保留，同时恢复账号为启用调度状态。

临时网络错误、代理风控、`429` 或 Sub2API 短时不可用只会进入 5 分钟冷却。如果登录返回明确的 `account_deactivated`、`account_deleted` 或同类永久停用信息，任务会被标记为永久跳过，下次巡检不再重试。用户仍可手动点击“重新登录并授权”重新确认账号状态。

启用监控后，Sub2API 后端地址和管理员 API Key 会由本机服务保存在运行数据目录的 `sub2api-monitor.json` 中，但不会写入账号任务元数据、协议日志、状态接口或导出文件。

## 直接同步到 CPAMP

页面顶部的“CPAMP 同步”区域用于把已完成任务的 OAuth 授权直接写入 CPAMP，无需再下载文件并去 CPAMP 管理页面手工导入。首次配置时填写：

- CPAMP API 根地址，例如 `https://cpamp.example.com`；不要填写 `management.html#/accounts` 等管理页面地址。
- CPAMP 管理密钥。该密钥只保存在当前 Windows 用户可解密的 DPAPI 密文中，不会写入浏览器、本地任务文件、日志或 Git 仓库。
- 可选的“自动同步以后新完成的任务”。开启后，只有之后完成的任务才会进入同步流程。每个邮箱的首次自动外发会先显示为待确认，选中后点击“确认待同步”才会发送；确认过的邮箱以后会自动更新。

手动同步时，选择一个或多个已完成账号，点击“同步到 CPAMP”，确认提示后即可完成。相同邮箱会优先更新曾关联的远端认证文件；若远端存在多个同邮箱文件，只更新其中主文件并保留其他文件。更新时只替换 OAuth 授权字段，保留 CPAMP 已设置的优先级、代理、备注、启用状态、模型限制等配置。

CPAMP 配置中还可以为**新建**账号设置默认策略：是否启用、固定代理或沿用本次 AutoTo 登录代理、优先级、调度权重、仅允许的模型，以及批量同步并发数（1、3 或 5）。模型限制会先读取 CPAMP 的 Codex 模型目录，并将未允许的模型写入 CPAMP 的 `excluded_models`；模型目录无法读取时会拒绝此次需要应用策略的同步，避免意外导入为不限模型。对于已存在的同邮箱账号，只有在本地页面选中后使用“强制应用 CPAMP 策略”并二次确认，才会覆盖远端的代理、优先级、权重、启停状态和模型限制；备注始终保留。

可选启用“同步关联巡检”。它每 5 分钟只读取 AutoTo 已建立关联的 CPAMP 文件，标记远端文件缺失、CPAMP 已禁用或已返回的明确异常状态；不会调用 CPAMP 的全局巡检接口，也不会自动重新授权、启停账号或修改远端配置。

临时网络、限流或服务器错误会自动逐步重试，最多 5 次；密钥、权限或文件格式等明确错误不会反复发送。

## 输出文件

任务运行数据默认保存在：

```text
tmp/chatgpt-onboarding-console/<任务 ID>/
```

每个完成任务会生成 `sub2api-import-oauth.json`。单账号和批量下载均输出标准 `sub2api-data` 格式。

也可以直接使用 CLI（命令行工具）：

```bash
node src/protocol-login.mjs --email you@example.com --verbose
```

查看全部参数：

```bash
node src/protocol-login.mjs --help
```

## 安全说明

- `tmp/` 中包含 Cookie（登录凭证）、OAuth Token（授权令牌）和登录检查点，禁止提交或分享。
- Windows 保存的密码和 2FA 密钥由 DPAPI（数据保护接口）按当前用户加密，不会以明文写入任务目录。
- CPAMP 管理密钥和同步关联记录分别保存在 `%LOCALAPPDATA%\toSub2\secrets` 和运行数据目录中；两者均已被 `.gitignore` 排除。
- sub2api 导入文件包含可用的授权令牌，应当按密码文件保护。
- 不要把 API Key、密码、2FA 密钥、验证码、Cookie 或 Token 提交到 Git 仓库。
- 网页控制台用于本机或可信局域网，不提供公网部署所需的身份认证。
- 只处理你本人持有或已获得明确授权的账号。

## 免责声明

本项目仅供学习、研究和管理本人账号使用，不隶属于 OpenAI，也未获得 OpenAI 背书。使用者应自行遵守 OpenAI 服务条款、相关平台规则以及所在地法律法规。因接口变更、账号限制、数据泄露或不当使用造成的后果由使用者自行承担。

## 更新日志

版本变化和升级说明请查看 [CHANGELOG.md](CHANGELOG.md)。

## License（开源许可证）

[MIT](LICENSE)
