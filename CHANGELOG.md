# 更新日志

## v1.1.0 - 2026-08-07

这是 toSub2 的首个正式 GitHub Release（版本发布），重点补齐 Windows 凭据持久化和跨平台验证。

### 新增

- Windows 使用当前用户的 DPAPI（数据保护接口）加密保存密码和 2FA 密钥。
- Windows 凭据密文保存在 `%LOCALAPPDATA%\toSub2\credentials`，只能由同一个 Windows 用户解密。
- 增加 Windows 和 Ubuntu 的 GitHub Actions（自动检查）。
- 增加网页控制台完整流程测试，覆盖任务创建、子进程启动、重新授权、下载和删除。
- 增加协议完整流程测试，覆盖邮箱验证码、手机号、短信验证码、检查点覆盖和 OAuth 文件刷新。

### 修复

- 修复 Windows 添加密码或 2FA 密钥时错误提示只能使用 macOS Keychain（钥匙串）的问题。
- 修复 Windows PowerShell（命令行）未加载 `System.Security`（系统安全程序集）导致 DPAPI 无法调用的问题。
- 修复 Windows 下中文或特殊字符密码可能受 PowerShell 默认编码影响的问题。
- 修复批量删除任务时，后台元数据写入与目录删除冲突，偶发返回 `ENOTEMPTY` 或 HTTP 500 的问题。
- 修复已删除任务仍可能继续写入 `job-meta.json` 的问题。

### 跨平台验证

- Windows 已验证 DPAPI 凭据保存、重启读取、覆盖更新和删除。
- Windows 已验证网页服务启动、Node.js 子进程和 UTF-8 页面输出。
- Windows 已验证登录检查点多次覆盖和 OAuth 导入文件原文件刷新。
- Windows 和 Ubuntu 均已通过完整自动检查。

### 已知限制

- Linux 可以使用邮箱验证码登录、Codex OAuth（授权登录）、手机号绑定和文件导出。
- Linux 暂不持久保存密码和 2FA 密钥，因为不同 Linux 环境不一定具备统一可用的系统凭据服务。
- Windows 使用 `--host 0.0.0.0` 开放局域网访问时，可能需要在系统防火墙中允许 Node.js 访问专用网络。

### 升级方式

```bash
git pull
npm install
npm run dev
```
