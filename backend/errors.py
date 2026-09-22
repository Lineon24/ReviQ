"""Public error categories; never expose provider bodies, keys or review text."""
from openai import APIConnectionError, APITimeoutError


class AnalysisError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def provider_error(error):
    status = getattr(error, "status_code", None)
    code = getattr(error, "code", None)
    error_type = getattr(error, "type", None)
    if isinstance(error, APITimeoutError):
        return AnalysisError("model_timeout", "AI 응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.")
    if isinstance(error, APIConnectionError):
        return AnalysisError("model_connection", "OpenAI에 연결하지 못했습니다. 분석 서버의 네트워크를 확인해주세요.")
    if status == 401 or code in ("invalid_api_key", "invalid_authentication"):
        return AnalysisError("model_auth", "OpenAI API 키 인증에 실패했습니다. 서버의 API 키를 확인해주세요.")
    if status == 403 or code == "model_not_found":
        return AnalysisError("model_access", "설정한 OpenAI 모델에 접근할 수 없습니다. 모델 이름과 사용 권한을 확인해주세요.")
    # SSE errors arrive as APIError without an HTTP status. Classify the
    # provider code/type as well as the initial HTTP response status.
    if status == 429 or code in (
        "credit_balance_exhausted", "project_spend_limit_exceeded",
        "organization_spend_limit_exceeded", "organization_usage_limit_exceeded",
        "insufficient_quota", "rate_limit_exceeded", "slow_down",
    ) or error_type in ("insufficient_quota", "rate_limit_error"):
        if code == "credit_balance_exhausted":
            return AnalysisError("model_credits", "OpenAI API 크레딧이 소진되었습니다. 해당 API 키의 조직에서 크레딧을 충전한 뒤 다시 시도해주세요.")
        if code == "project_spend_limit_exceeded":
            return AnalysisError("model_project_limit", "OpenAI 프로젝트의 지출 한도에 도달했습니다. 해당 프로젝트의 지출 한도를 확인해주세요.")
        if code == "organization_spend_limit_exceeded":
            return AnalysisError("model_organization_limit", "OpenAI 조직의 지출 한도에 도달했습니다. 조직의 지출 한도를 확인해주세요.")
        if code == "organization_usage_limit_exceeded":
            return AnalysisError("model_usage_limit", "OpenAI 조직의 승인된 사용 한도에 도달했습니다. 조직의 사용 한도 상향을 요청해주세요.")
        if code == "insufficient_quota" or error_type == "insufficient_quota":
            return AnalysisError("model_quota", "OpenAI API 사용 한도 또는 잔액이 부족합니다. 결제와 사용 한도를 확인해주세요.")
        if "request too large" in str(error).lower():
            return AnalysisError("model_request_too_large", "보고서와 원문의 요청 크기가 모델의 처리량 한도를 초과했습니다. 분석할 파일 범위를 줄이거나 해당 모델의 토큰 한도를 확인해주세요.")
        return AnalysisError("model_rate_limit", "AI 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해주세요.")
    if code == "context_length_exceeded":
        return AnalysisError("model_context", "모델이 처리할 수 있는 입력 길이를 초과했습니다. 파일을 나누거나 새 프로젝트에서 질문해주세요.")
    if status == 400:
        return AnalysisError("model_request", "AI 요청 형식이 서버에서 거절되었습니다. 분석 서버의 API 연동 설정을 확인해주세요.")
    if (status is not None and status >= 500) or code in ("server_error", "server_is_overloaded"):
        return AnalysisError("model_unavailable", "OpenAI 서비스에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.")
    return AnalysisError("model_error", "AI 호출에 실패했습니다. 잠시 후 다시 시도해주세요.")
