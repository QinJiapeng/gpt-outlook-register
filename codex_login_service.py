"""Codex OAuth 登录编排层。

这个文件只负责「流程怎么走」，不重新实现底层 HTTP 细节。

已有的 auth_flow.py 里已经有很多可复用能力：
  - 创建 HTTP session、维护 cookie
  - 生成 Sentinel token
  - 登录邮箱/密码、邮箱 OTP、手机号 OTP
  - 处理 workspace/session 选择页
  - 用 OAuth callback code 换 token

所以这里的 CodexLoginService 更像一个状态机包装器：
  1. 构造 Codex authorize URL
  2. 跟随跳转
  3. 如果需要登录/验证码/手机号，就进入对应处理分支
  4. 捕获 callback code
  5. 交换 access_token / refresh_token
  6. 可选保存结果
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from auth_flow import AuthFlow
from config import Config

logger = logging.getLogger(__name__)


class CodexLoginState(str, Enum):
    """Codex 登录流程的状态枚举。

    每个 public 方法都会返回 CodexLoginResult，其中 state 就是这里的值。
    WebUI 后面接入时，可以根据 state 决定下一步显示什么：
      - EMAIL_OTP_REQUIRED: 提示用户等邮箱验证码，或让 provider 自动取码
      - PHONE_REQUIRED: 提示用户输入手机号或短信验证码
      - CALLBACK_CAPTURED: 已拿到 OAuth code，可以 exchange_token()
      - TOKEN_EXCHANGED: 已经拿到 token
      - FAILED: 流程失败，看 error 字段
    """

    INIT = "init"
    AUTHORIZE_BUILT = "authorize_built"
    AUTHORIZE_FOLLOWED = "authorize_followed"
    LOGIN_REQUIRED = "login_required"
    EMAIL_OTP_REQUIRED = "email_otp_required"
    PHONE_REQUIRED = "phone_required"
    WORKSPACE_SELECT_REQUIRED = "workspace_select_required"
    SESSION_SELECT_REQUIRED = "session_select_required"
    CALLBACK_CAPTURED = "callback_captured"
    TOKEN_EXCHANGED = "token_exchanged"
    PERSISTED = "persisted"
    FAILED = "failed"


@dataclass
class CodexOAuthContext:
    """一次 Codex OAuth 流程中的中间变量。

    这些值不是最终账号凭证，而是 OAuth 流程需要用到的上下文：
      - auth_url: 第一步生成的授权 URL
      - state: OAuth state，用于防止 callback 串流程
      - verifier: PKCE code_verifier，换 token 时必须原样带回
      - redirect_uri/client_id: Codex OAuth 客户端参数
      - callback_url/callback_code: 授权成功后捕获到的 code
      - final_url/continue_url: 跟随跳转时用于判断下一步的 URL
    """

    auth_url: str = ""
    state: str = ""
    verifier: str = ""
    redirect_uri: str = ""
    client_id: str = ""
    callback_url: str = ""
    callback_code: str = ""
    final_url: str = ""
    continue_url: str = ""


@dataclass
class CodexLoginResult:
    """每一步返回给调用方的统一结果。

    ok:
        表示当前步骤是否已经达成一个成功结果。注意「需要 OTP」不是异常，
        所以 ok 可能是 False，但 state 是 EMAIL_OTP_REQUIRED。

    state:
        当前流程状态，调用方用它决定下一步做什么。

    next_url:
        当前状态关联的 URL。例如需要登录时通常是 /log-in，
        捕获 callback 时就是 callback URL。

    credentials:
        AuthFlow.result.to_dict() 的快照。真正的 access_token、refresh_token、
        session_token 都在这里。
    """

    ok: bool = False
    state: CodexLoginState = CodexLoginState.INIT
    message: str = ""
    next_url: str = ""
    error: str = ""
    context: CodexOAuthContext = field(default_factory=CodexOAuthContext)
    credentials: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """转成普通 dict，方便打印 JSON、WebUI 返回、写文件。

        verifier 是敏感值，且长度很长；这里默认只输出 verifier_len，
        避免日志里泄露 code_verifier。
        """
        return {
            "ok": self.ok,
            "state": self.state.value,
            "message": self.message,
            "next_url": self.next_url,
            "error": self.error,
            "context": {
                "auth_url": self.context.auth_url,
                "state": self.context.state,
                "redirect_uri": self.context.redirect_uri,
                "client_id": self.context.client_id,
                "callback_url": self.context.callback_url,
                "callback_code": self.context.callback_code,
                "final_url": self.context.final_url,
                "continue_url": self.context.continue_url,
                "verifier_len": len(self.context.verifier or ""),
            },
            "credentials": self.credentials,
        }


class CodexLoginService:
    """有状态的 Codex OAuth 登录服务。

    这个类保留 self.context 和 self.flow，因此同一个实例要按顺序调用。

    public 方法对应你要的链路：

    build_authorize_url -> follow_authorize_chain -> resolve_login_required
    -> resolve_email_otp_required -> resolve_phone_required
    -> capture_callback_code -> exchange_token -> persist_result

    命令行入口 codex_login.py 会调用 run() 一口气跑；WebUI 接入时可以
    分步骤调用这些方法，这样遇到手机号/OTP 时可以暂停，让用户手动输入。
    """

    def __init__(
        self,
        config: Optional[Config] = None,
        flow: Optional[AuthFlow] = None,
        mail_provider: Any = None,
    ):
        """创建服务实例。

        Args:
            config: 项目已有 Config，主要用 proxy。
            flow: 可选的 AuthFlow。一般不用传，除非你已经创建并灌入了 cookie。
            mail_provider: 邮箱 provider。OutlookMailProvider 和 CFTempEmailProvider 都可以，
                只要实现 wait_for_otp(email, timeout, issued_after) 即可。
        """
        self.config = config or Config()
        self.flow = flow or AuthFlow(self.config)
        self.mail_provider = mail_provider
        self.context = CodexOAuthContext()
        self.last_result = CodexLoginResult(context=self.context)

    @classmethod
    def from_existing_credentials(
        cls,
        session_token: str,
        access_token: str = "",
        device_id: str = "",
        email: str = "",
        password: str = "",
        config: Optional[Config] = None,
        mail_provider: Any = None,
    ) -> "CodexLoginService":
        """用已有 ChatGPT 凭证创建服务。

        适合「账号已经注册/登录过，只想重新走 Codex OAuth 拿 refresh_token」。

        session_token:
            ChatGPT 的 __Secure-next-auth.session-token cookie。

        access_token:
            ChatGPT /api/auth/session 返回的 accessToken。可以作为 session_token
            不存在时的兜底，但更推荐传 session_token。
        """
        service = cls(config=config, mail_provider=mail_provider)
        service.flow.from_existing_credentials(
            session_token=session_token,
            access_token=access_token,
            device_id=device_id,
        )
        if email:
            service.flow.result.email = email
        if password:
            service.flow.result.password = password
        return service

    def _result(
        self,
        state: CodexLoginState,
        ok: bool = False,
        message: str = "",
        next_url: str = "",
        error: str = "",
    ) -> CodexLoginResult:
        """构造并记录一个统一返回对象。

        这个私有方法只是减少重复代码：每个步骤结束时都用它更新
        self.last_result，并把当前 AuthFlow 的凭证快照带出去。
        """
        self.last_result = CodexLoginResult(
            ok=ok,
            state=state,
            message=message,
            next_url=next_url,
            error=error,
            context=self.context,
            credentials=self.flow.result.to_dict(),
        )
        return self.last_result

    def build_authorize_url(self) -> CodexLoginResult:
        """生成 Codex OAuth authorize URL。

        这里会生成 OAuth state 和 PKCE verifier/challenge。后面 exchange_token()
        必须使用同一个 verifier，所以这些值会保存到 self.context。
        """
        auth_url, state, verifier, redirect_uri, client_id = self.flow._build_codex_authorize()
        self.context.auth_url = auth_url
        self.context.state = state
        self.context.verifier = verifier
        self.context.redirect_uri = redirect_uri
        self.context.client_id = client_id

        self.flow._oauth_auth_url = auth_url
        self.flow._oauth_client_id = client_id
        self.flow._oauth_redirect_uri = redirect_uri
        self.flow._oauth_state = state
        self.flow._manual_login_verifier = verifier
        self.flow._captured_login_verifier = verifier

        return self._result(
            CodexLoginState.AUTHORIZE_BUILT,
            message="Codex authorize URL built",
            next_url=auth_url,
        )

    def follow_authorize_chain(self, start_url: str = "", trace_prefix: str = "codex_authorize") -> CodexLoginResult:
        """跟随 authorize/continue 跳转，尝试捕获 callback code。

        如果当前浏览器会话/cookie 已经登录，通常会直接跳到 callback。
        如果没有登录，可能停在 /log-in；此时返回 LOGIN_REQUIRED。
        如果命中手机号验证，返回 PHONE_REQUIRED。
        """
        if not start_url:
            start_url = self.context.auth_url
        if not start_url:
            built = self.build_authorize_url()
            start_url = built.next_url

        callback_url, final_url = self.flow._follow_authorize_for_callback(
            start_url,
            self.context.redirect_uri,
            trace_prefix,
        )
        self.context.callback_url = callback_url
        self.context.final_url = final_url

        if callback_url:
            return self.capture_callback_code(callback_url)

        normalized = self.flow._normalize_continue_url(final_url or "")
        self.context.continue_url = normalized or final_url or ""
        lower_final = (self.context.continue_url or "").lower()
        if "/log-in" in lower_final:
            return self._result(
                CodexLoginState.LOGIN_REQUIRED,
                message="Codex authorize requires account login",
                next_url=self.context.continue_url,
            )
        if self.flow._is_add_phone_state(continue_url=self.context.continue_url):
            return self._result(
                CodexLoginState.PHONE_REQUIRED,
                message="Codex authorize requires phone verification",
                next_url=self.context.continue_url,
            )

        return self._result(
            CodexLoginState.AUTHORIZE_FOLLOWED,
            message="Authorize chain followed, but no callback code was captured",
            next_url=self.context.continue_url,
        )

    def resolve_login_required(
        self,
        email: str = "",
        password: str = "",
        mail_provider: Any = None,
    ) -> CodexLoginResult:
        """处理「需要登录」分支。

        这个方法会：
          1. 用 email 调 authorize/continue，screen_hint=login
          2. 如果需要密码，调 password/verify
          3. 如果需要邮箱 OTP，转给 resolve_email_otp_required()
          4. 如果需要手机号，返回 PHONE_REQUIRED
          5. 如果拿到 continue_url，继续 follow_authorize_chain()

        mail_provider:
            如果登录过程需要邮箱 OTP，且你希望自动取码，就传 provider。
            不传时会返回 EMAIL_OTP_REQUIRED，让上层自己处理。
        """
        email = (email or self.flow.result.email or "").strip()
        if not email:
            return self._result(CodexLoginState.FAILED, error="email is required to resolve login")
        password = (password or self.flow.result.password or self.flow._default_password_from_email(email)).strip()
        self.flow.result.email = email
        self.flow.result.password = password

        device_id = (
            (self.flow.result.device_id or "").strip()
            or (self.flow.session.cookies.get("oai-did", "") or "").strip()
        )
        if not device_id:
            # A generated device id is only a continuity fallback for the local flow.
            import uuid

            device_id = str(uuid.uuid4())
            self.flow.result.device_id = device_id

        sentinel = self.flow.get_sentinel_token(device_id)
        step = self.flow.authorize_continue(
            email=email,
            sentinel_token=sentinel,
            screen_hint="login",
            referer="https://auth.openai.com/log-in",
            trace_step="codex_login_authorize_continue",
        )
        page_type = self.flow._extract_page_type(step)
        continue_url = self.flow._normalize_continue_url(self.flow._extract_continue_url_from_step(step))
        self.context.continue_url = continue_url

        if page_type == "login_password" or "/log-in/password" in (continue_url or ""):
            step = self.flow.login_password_verify(password)
            page_type = self.flow._extract_page_type(step)
            continue_url = self.flow._normalize_continue_url(self.flow._extract_continue_url_from_step(step))
            self.context.continue_url = continue_url

        need_email_otp = page_type == "email_otp_verification" or "/email-verification" in (continue_url or "")
        if need_email_otp:
            return self.resolve_email_otp_required(
                continue_url=continue_url,
                mail_provider=mail_provider,
            )

        if self.flow._is_add_phone_state(page_type=page_type, continue_url=continue_url):
            return self._result(
                CodexLoginState.PHONE_REQUIRED,
                message="Phone verification is required",
                next_url=continue_url,
            )

        if continue_url:
            return self.follow_authorize_chain(continue_url, trace_prefix="codex_post_login")

        return self._result(
            CodexLoginState.AUTHORIZE_FOLLOWED,
            message="Login was resolved, but no continuation URL was returned",
        )

    def resolve_email_otp_required(
        self,
        continue_url: str = "",
        mail_provider: Any = None,
        otp_code: str = "",
    ) -> CodexLoginResult:
        """处理邮箱 OTP 分支。

        两种用法：
          - 自动取码：传 mail_provider，让 provider.wait_for_otp() 去邮箱里拉验证码
          - 手动取码：传 otp_code，适合 WebUI 用户自己输入验证码

        验证成功后，如果返回手机号验证页，会返回 PHONE_REQUIRED；
        否则继续跟随下一跳，直到 callback 或其他终态。
        """
        provider = mail_provider or self.mail_provider
        continue_url = self.flow._normalize_continue_url(continue_url or self.context.continue_url)
        self.context.continue_url = continue_url

        if not otp_code:
            if provider is None:
                return self._result(
                    CodexLoginState.EMAIL_OTP_REQUIRED,
                    message="Email OTP is required",
                    next_url=continue_url,
                )
            import os
            import time

            try:
                otp_timeout = max(30, int(os.getenv("OTP_TIMEOUT", "60")))
            except Exception:
                otp_timeout = 60
            issued_after = time.time()
            if not self.flow.kickoff_otp_delivery("codex_login_need_otp"):
                self.flow.send_otp(referer="https://auth.openai.com/email-verification")
            otp_code = provider.wait_for_otp(
                self.flow.result.email,
                timeout=otp_timeout,
                issued_after=issued_after,
            )

        step = self.flow.verify_otp(otp_code)
        page_type = self.flow._extract_page_type(step)
        next_url = self.flow._normalize_continue_url(self.flow._extract_continue_url_from_step(step))
        self.context.continue_url = next_url

        if self.flow._is_add_phone_state(page_type=page_type, continue_url=next_url):
            return self._result(
                CodexLoginState.PHONE_REQUIRED,
                message="Phone verification is required after email OTP",
                next_url=next_url,
            )
        if next_url:
            return self.follow_authorize_chain(next_url, trace_prefix="codex_post_email_otp")
        return self._result(
            CodexLoginState.AUTHORIZE_FOLLOWED,
            message="Email OTP was accepted, but no continuation URL was returned",
        )

    def resolve_phone_required(
        self,
        continue_url: str = "",
        phone_number: str = "",
        phone_otp: str = "",
    ) -> CodexLoginResult:
        """处理手机号验证分支。

        支持两段式调用，方便 WebUI：
          1. 第一次只传 phone_number：发送短信验证码，返回 PHONE_REQUIRED
          2. 第二次只传 phone_otp：校验短信验证码，然后继续授权链路

        也支持一次性同时传 phone_number + phone_otp。
        """
        continue_url = self.flow._normalize_continue_url(continue_url or self.context.continue_url)
        self.context.continue_url = continue_url

        if phone_otp and not phone_number:
            validate_resp = self.flow._phone_otp_validate(phone_otp)
            next_url = self.flow._normalize_continue_url(self.flow._extract_continue_url_from_step(validate_resp))
            self.context.continue_url = next_url or self.context.continue_url
            if next_url:
                return self.follow_authorize_chain(next_url, trace_prefix="codex_post_phone")
            return self.follow_authorize_chain(self.context.auth_url, trace_prefix="codex_post_phone_reauthorize")

        if not phone_number:
            return self._result(
                CodexLoginState.PHONE_REQUIRED,
                message="Phone number is required",
                next_url=continue_url,
            )
        send_resp = self.flow._add_phone_send(phone_number)
        send_page_type = self.flow._extract_page_type(send_resp)
        send_continue = self.flow._normalize_continue_url(self.flow._extract_continue_url_from_step(send_resp))
        if send_continue:
            self.context.continue_url = send_continue

        if not phone_otp:
            return self._result(
                CodexLoginState.PHONE_REQUIRED,
                message="Phone OTP is required",
                next_url=self.context.continue_url,
            )

        validate_resp = self.flow._phone_otp_validate(phone_otp)
        next_url = self.flow._normalize_continue_url(self.flow._extract_continue_url_from_step(validate_resp))
        self.context.continue_url = next_url or self.context.continue_url

        if send_page_type and send_page_type not in ("phone_otp_verification", "external_url"):
            logger.info("Unexpected phone send page_type=%s", send_page_type)
        if next_url:
            return self.follow_authorize_chain(next_url, trace_prefix="codex_post_phone")
        return self.follow_authorize_chain(self.context.auth_url, trace_prefix="codex_post_phone_reauthorize")

    def capture_callback_code(self, callback_url: str = "") -> CodexLoginResult:
        """从 OAuth callback URL 里提取 code。

        callback URL 形如：
          http://localhost:1455/auth/callback?code=xxx&state=yyy

        这里会校验 state，防止拿到的 callback 不属于当前这次 OAuth 流程。
        """
        callback_url = callback_url or self.context.callback_url
        if not callback_url:
            return self._result(CodexLoginState.FAILED, error="callback_url is required")

        qs = parse_qs(urlparse(callback_url).query)
        code = (qs.get("code", [""])[0] or "").strip()
        got_state = (qs.get("state", [""])[0] or "").strip()
        if not code:
            return self._result(CodexLoginState.FAILED, error="callback URL does not contain code")
        if self.context.state and got_state and got_state != self.context.state:
            return self._result(CodexLoginState.FAILED, error="callback state mismatch")

        self.context.callback_url = callback_url
        self.context.callback_code = code
        return self._result(
            CodexLoginState.CALLBACK_CAPTURED,
            ok=True,
            message="Callback code captured",
            next_url=callback_url,
        )

    def exchange_token(self, callback_url: str = "") -> CodexLoginResult:
        """用 callback code 换 Codex token。

        这一步会调用 auth.openai.com/oauth/token，成功后 AuthFlow.result 里会有：
          - access_token
          - refresh_token
          - id_token

        注意 callback code 通常只能消费一次，失败后最好重新 authorize。
        """
        if callback_url:
            captured = self.capture_callback_code(callback_url)
            if captured.state == CodexLoginState.FAILED:
                return captured
        if not self.context.callback_url:
            return self._result(CodexLoginState.FAILED, error="callback code has not been captured")

        ok = self.flow._exchange_codex_callback_code(
            callback_url=self.context.callback_url,
            expected_state=self.context.state,
            verifier=self.context.verifier,
            redirect_uri=self.context.redirect_uri,
            client_id=self.context.client_id,
        )
        if not ok:
            return self._result(CodexLoginState.FAILED, error="Codex token exchange failed")
        return self._result(
            CodexLoginState.TOKEN_EXCHANGED,
            ok=True,
            message="Codex token exchange succeeded",
        )

    def persist_result(self, path: str | Path = "") -> CodexLoginResult:
        """把当前凭证保存到 JSON 文件。

        path 不传时，默认写到当前目录：
          codex_login_<email>.json
        """
        if not path:
            email = (self.flow.result.email or "codex").replace("@", "_at_")
            path = Path.cwd() / f"codex_login_{email}.json"
        out_path = Path(path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        payload = self.flow.result.to_dict()
        payload["codex_oauth"] = {
            "client_id": self.context.client_id,
            "redirect_uri": self.context.redirect_uri,
            "state": self.context.state,
            "callback_url": self.context.callback_url,
            "callback_code_present": bool(self.context.callback_code),
        }
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._result(
            CodexLoginState.PERSISTED,
            ok=True,
            message=f"Codex login result persisted: {out_path}",
        )

    def run(
        self,
        email: str = "",
        password: str = "",
        mail_provider: Any = None,
        persist_path: str | Path = "",
    ) -> CodexLoginResult:
        """一口气跑完整 Codex 登录流程。

        这是命令行入口最常用的方法。它会自动处理：
          - authorize URL 生成
          - 授权跳转
          - 必要的邮箱/密码登录
          - callback 捕获
          - token exchange
          - 可选保存文件

        但如果中途需要手机号，run() 不会凭空知道手机号和短信码，
        会返回 PHONE_REQUIRED，调用方再用 resolve_phone_required() 继续。
        """
        try:
            email = (email or self.flow.result.email or "").strip()
            password = (password or self.flow.result.password or "").strip()
            if email:
                self.flow.result.email = email
            if password:
                self.flow.result.password = password

            built = self.build_authorize_url()
            followed = self.follow_authorize_chain(built.next_url)

            current = followed
            if current.state == CodexLoginState.LOGIN_REQUIRED or (
                current.state == CodexLoginState.AUTHORIZE_FOLLOWED
                and not self.context.callback_url
                and email
            ):
                current = self.resolve_login_required(
                    email=email,
                    password=password,
                    mail_provider=mail_provider,
                )

            if current.state == CodexLoginState.CALLBACK_CAPTURED:
                current = self.exchange_token()

            if current.state == CodexLoginState.TOKEN_EXCHANGED and persist_path:
                current = self.persist_result(persist_path)

            return current
        except Exception as e:
            logger.exception("Codex login failed")
            return self._result(CodexLoginState.FAILED, error=str(e))
