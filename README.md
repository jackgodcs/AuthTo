# toSub2

QQ 交流群：`1085165735`

[点击链接加入群聊【toSub2】](https://qm.qq.com/q/n40xuIClm8)

toSub2 是一个本地网页工具，通过协议请求完成 ChatGPT 登录和 Codex OAuth（授权登录），自动判断账号是否需要绑定手机号，并生成可供 sub2api 导入的 JSON（结构化数据）文件。

> 本项目不是 OpenAI 官方项目。上游登录接口随时可能变化。

![toSub2 控制台](docs/console.png)

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
- 已完成账号可以单个或批量创建新的 TOTP 2FA（基于时间的一次性密码），程序会自动生成并提交激活验证码，密钥不会写入协议日志。
- 自动跳过已经完成手机号绑定的账号。
- 未绑定账号支持手动手机号、手动短信验证码，以及 LubanSMS、SMSBower、自定义号码池自动取号收码。
- 邮箱登录成功后立即保存 checkpoint（检查点），中断后可继续手机号流程。
- 支持单个和批量重新授权；“重新授权”优先使用已有 Refresh Token（刷新令牌），“重新登录并授权”会跳过刷新令牌和旧检查点，强制重新完成登录与授权。
- 支持分页、精确筛选、跨页多选、批量删除、停止全部、批量重新授权和批量下载。
- 最终输出 sub2api 导入格式，下载文件名自动附带时间戳。

## 环境要求

- Node.js 20 或更高版本，建议使用 Node.js 22。
- Python 3.9 或更高版本；默认协议登录流程需要安装 `curl_cffi`（浏览器 TLS 指纹请求库），即使不使用代理也需要。
- macOS 使用 Keychain（钥匙串）持久保存密码、2FA 密钥和账号代理。
- Windows 使用当前用户的 DPAPI（数据保护接口）加密保存上述数据，密文位于 `%LOCALAPPDATA%\toSub2\credentials`，只能由同一个 Windows 用户解密。
- Linux 仍可使用邮箱验证码流程，但目前不持久保存密码、2FA 密钥和账号代理；服务重启后不会让原本配置代理的排队任务悄悄改用本机网络。

## 安装与启动

```bash
git clone https://github.com/poxiao33/toSub2.git
cd toSub2
npm install
python -m pip install -r requirements.txt
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:4399
```

指定其他端口：

```bash
npm run dev -- --port 4400
```

允许局域网设备访问：

```bash
npm run dev -- --host 0.0.0.0
```

局域网模式没有访问认证，只应在可信网络内短时间使用。

## 账号代理和 TLS 指纹

网页顶部的“代理 IP”输入框配置账号登录使用的代理。支持以下格式：

```text
http://用户名:密码@主机:端口
socks5h://用户名:密码@主机:端口
socks5h://account-id:proxy-secret-JP-91977332-20m@proxy.example.com:1000
```

如果用户名中存在 `-sid-xxxxxxxx-t-20`，或者密码中存在 `-JP-12345678-20m` 这样的会话字段，toSub2 会为每个任务随机生成新的会话编号，并使用 `curl_cffi` 的 `chrome146`（Chrome 146 浏览器指纹）真实访问 `chatgpt.com` 检测出口。HTTP 风控响应会更换会话，最多使用 10 个有响应的代理会话；TLS、超时等纯连接失败不占这 10 次，但连续连接失败达到 20 次也会停止，避免网络异常时无限循环。代理检测通过后，如果在邮箱登录、2FA、手机号绑定、工作区选择或 OAuth（授权登录）阶段再次遇到 403 HTML 风控页，任务会清除本次无效登录状态、换新代理会话并从当前流程起点自动重试。没有可识别会话字段的固定代理不会重复轮换，失败后直接提示用户更换代理。

代理输入为空时使用本机网络。页面设置保存在当前浏览器的 localStorage（本地存储）中；创建任务、重试和重新授权会读取输入框当前最新内容。任务实际使用的代理还会保存在系统安全凭据存储中，以便服务重启后恢复排队任务。代理密码不会写入 `job-meta.json`（任务元数据）或日志。

Python 辅助进程默认使用 `python3`（macOS/Linux）或 `python`/`py -3`（Windows）。如果系统有多个 Python，可以设置环境变量 `TOSUB2_PYTHON` 指定解释器路径。

## 批量添加格式

每行一个账号，支持以下格式：

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

第二段以 `http://` 或 `https://` 开头时按邮箱收码接口处理，否则按密码处理。密码后的字段以 `http://` 或 `https://` 开头时，作为密码登录的备用邮件收码接口；如果还有第四段，则按 2FA 密钥处理。只有邮箱和 2FA 密钥、登录时手动填写邮箱验证码的账号，可使用连续 8 个短横线的 `邮箱--------2FA密钥` 格式。邮箱是唯一字段，重复导入会更新原任务资料。

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

配置只保存在当前浏览器的 `localStorage`（本地存储），不会写入账号任务元数据、协议日志或导出文件。批量上传时，未完成的任务会自动跳过；服务端返回的创建失败数量会显示在控制台中。

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
