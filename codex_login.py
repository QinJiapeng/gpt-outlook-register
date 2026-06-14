#!/usr/bin/env python3
"""Codex OAuth 登录的命令行入口。

这个文件主要用于本地手动测试。真正的业务逻辑在 codex_login_service.py。

你可以把它理解为：
  - 解析命令行参数
  - 根据参数创建 Outlook 或 CF 邮箱 provider
  - 创建 CodexLoginService
  - 调 service.run()
  - 把结果打印成 JSON

后面如果接 WebUI，WebUI 应该直接调用 CodexLoginService，而不是调用这个
命令行脚本。

Usage:
  python codex_login.py --email user@example.com --password '<pwd>'
  python codex_login.py --existing-session '<session_token>' --email user@example.com
  python codex_login.py --outlook 'email----password----client_id----refresh_token'
  python codex_login.py --email user@example.com --cf-api-url ... --cf-domain ... --cf-admin-token ...
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from codex_login_service import CodexLoginService, CodexLoginState  # noqa: E402
from config import Config  # noqa: E402
from mail_outlook import OutlookMailProvider  # noqa: E402


def _build_parser() -> argparse.ArgumentParser:
    """定义命令行参数。

    argparse 是 Python 标准库，用来把类似 --email xxx 的参数解析成 args.email。
    """
    p = argparse.ArgumentParser(description="Standalone Codex OAuth login")
    p.add_argument("--email", default=os.getenv("CODEX_EMAIL", ""), help="OpenAI account email")
    p.add_argument("--password", default=os.getenv("CODEX_PASSWORD", ""), help="OpenAI account password")
    p.add_argument("--out", default="", help="Write credentials JSON to this path after token exchange")
    p.add_argument("--proxy", default=os.getenv("PROXY", ""), help="Proxy URL")
    p.add_argument("--existing-session", default="", help="Existing ChatGPT session token")
    p.add_argument("--existing-access-token", default="", help="Existing ChatGPT access token")
    p.add_argument("--device-id", default="", help="Existing oai-did/device id")
    p.add_argument(
        "--outlook",
        default="",
        help="Outlook OTP account: email----password----client_id----microsoft_refresh_token",
    )
    p.add_argument("--cf-api-url", default=os.getenv("CF_API_URL", ""), help="CF Temp Email Worker URL")
    p.add_argument("--cf-domain", default=os.getenv("CF_DOMAIN", ""), help="CF Temp Email catch-all domain")
    p.add_argument(
        "--cf-admin-token",
        default=os.getenv("CF_ADMIN_TOKEN", ""),
        help="CF Temp Email admin token",
    )
    p.add_argument(
        "--cf-new-mailbox",
        action="store_true",
        help="Create a new CF mailbox when --email is not supplied",
    )
    return p


def main() -> int:
    """命令行主函数。

    返回值约定：
      0 = 成功
      1 = 流程失败
      2 = 参数错误
      3 = 流程暂停，需要用户继续提供 OTP/手机号等信息
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    args = _build_parser().parse_args()

    cfg = Config()
    cfg.proxy = args.proxy.strip() or None

    mail_provider = None
    email = args.email.strip()
    password = args.password.strip()

    # Outlook 模式：直接用项目原来的四段格式。
    # 四段分别是 OpenAI 登录邮箱、邮箱密码、Microsoft client_id、Microsoft refresh_token。
    # 这里的 refresh_token 是用来登录 Outlook IMAP 收 OpenAI 邮件的，不是 Codex refresh_token。
    if args.outlook:
        parts = args.outlook.split("----")
        if len(parts) != 4:
            print(f"--outlook must contain 4 fields, got {len(parts)}", file=sys.stderr)
            return 2
        email, password, client_id, refresh_token = parts
        mail_provider = OutlookMailProvider(
            email=email,
            password=password,
            client_id=client_id,
            refresh_token=refresh_token,
        )

    # CF 模式：使用 cloudflare_temp_email 这类 Worker 自建 catch-all 邮箱。
    # 如果传了 --email，就用这个邮箱去收 OTP。
    # 如果没传 --email 且传了 --cf-new-mailbox，就先调用 Worker 创建一个新邮箱。
    elif args.cf_api_url or args.cf_domain or args.cf_admin_token:
        if not (args.cf_api_url and args.cf_domain and args.cf_admin_token):
            print(
                "--cf-api-url, --cf-domain and --cf-admin-token are required for CF mode",
                file=sys.stderr,
            )
            return 2
        from mail_cf import CFTempEmailProvider

        mail_provider = CFTempEmailProvider(
            api_url=args.cf_api_url,
            admin_token=args.cf_admin_token,
            domain=args.cf_domain,
        )
        if not email and args.cf_new_mailbox:
            email = mail_provider.create_mailbox()
        if not email:
            print("CF mode requires --email, unless --cf-new-mailbox is used", file=sys.stderr)
            return 2

    # 如果已经有 ChatGPT session/access token，就先把凭证灌进 AuthFlow。
    # 这种模式适合“已有号重拿 Codex refresh_token”，不一定需要重新走完整登录。
    if args.existing_session or args.existing_access_token:
        service = CodexLoginService.from_existing_credentials(
            session_token=args.existing_session,
            access_token=args.existing_access_token,
            device_id=args.device_id,
            email=email,
            password=password,
            config=cfg,
            mail_provider=mail_provider,
        )
    else:
        service = CodexLoginService(config=cfg, mail_provider=mail_provider)

    # run() 会尽量自动跑完整流程。
    # 如果遇到无法自动完成的步骤，例如手机号验证，它会返回 PHONE_REQUIRED。
    result = service.run(
        email=email,
        password=password,
        mail_provider=mail_provider,
        persist_path=args.out,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))

    # 返回 3 表示流程不是失败，而是暂停等待用户继续输入。
    # 以后接 WebUI 时，可以根据 result.state 显示对应输入框。
    if result.state in (CodexLoginState.EMAIL_OTP_REQUIRED, CodexLoginState.PHONE_REQUIRED):
        return 3
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
