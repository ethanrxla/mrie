"""NVIDIA NIM provider — free-tier OpenAI-compatible LLM."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

from tenacity import retry, retry_if_not_exception_type, stop_after_attempt, wait_exponential

from mrie.providers.base import ModelProvider, ProviderUnavailableError

try:
    from openai import AsyncOpenAI
except ImportError:
    AsyncOpenAI = None  # type: ignore[misc, assignment]


class NVIDIANIMProvider(ModelProvider):
    """OpenAI-compatible client for NVIDIA NIM free tier."""

    DEFAULT_BASE = "https://integrate.api.nvidia.com/v1"
    DEFAULT_MODEL = "deepseek-ai/deepseek-v4-flash-0731"
    name = "nvidia_nim"

    def __init__(self, config: dict[str, Any]) -> None:
        self.base_url = config.get("base_url", self.DEFAULT_BASE)
        self.model = config.get("model", self.DEFAULT_MODEL)
        self.api_key_env = config.get("api_key_env", "NVIDIA_NIM_API_KEY")
        self.rate_limit_rpm = int(config.get("rate_limit_rpm", 40))
        self._request_times: list[float] = []
        self._client = None
        api_key = os.environ.get(self.api_key_env)
        if AsyncOpenAI is not None and api_key:
            self._client = AsyncOpenAI(api_key=api_key, base_url=self.base_url)

    def get_status(self) -> dict[str, Any]:
        return {
            "name": "nvidia_nim",
            "model": self.model,
            "base_url": self.base_url,
            "rate_limit_rpm": self.rate_limit_rpm,
            "configured": bool(os.environ.get(self.api_key_env)),
        }

    async def _throttle(self) -> None:
        now = time.monotonic()
        self._request_times = [t for t in self._request_times if now - t < 60]
        if len(self._request_times) >= self.rate_limit_rpm:
            sleep_for = 60 - (now - self._request_times[0])
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)
        self._request_times.append(time.monotonic())

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        retry=retry_if_not_exception_type((ProviderUnavailableError, ValueError)),
        reraise=True,
    )
    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if self._client is None:
            raise ProviderUnavailableError(f"NVIDIA NIM is not configured; set {self.api_key_env}")

        await self._throttle()
        kwargs: dict[str, Any] = {"model": self.model, "messages": messages}
        if tools:
            kwargs["tools"] = tools

        response = await self._client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        message = choice.message

        tool_calls: list[dict[str, Any]] = []
        if message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append(
                    {
                        "id": tc.id,
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                )

        return {
            "content": message.content or "",
            "tool_calls": tool_calls,
        }
